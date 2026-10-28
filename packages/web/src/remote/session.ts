/**
 * Session Remote value builders (dsh 0.2.x `session` namespace).
 *
 * Maps the {@link WebDriver} face onto the session-controller wire shapes:
 * list summaries, projection baselines, history pages, and the follow
 * opening snapshot. The driver's translated journal already lives in one
 * contiguous seq space whose watermark is -1 for an empty log, which is
 * exactly the cursor space the 0.2.x journal contract expects.
 */

import type { WebDriver, WebSessionSummary } from "../protocol/driver";
import type { WebSessionEvent } from "../protocol/events";

/** Projection values bag (JSON-safe values keyed by projection name). */
export type ProjectionValues = Record<string, unknown>;

/**
 * The field bag of a verb whose host signature takes ONE request object:
 * the wire carries that object under its parameter name (`args.request`),
 * while scalar-param verbs ride flat. Returns the flat bag unchanged when
 * no request object rides along, so both serializations validate by the
 * same field names. (Observed on the wire: workspace/create, the whole
 * session controller and the session/follow stream are request-shaped;
 * directoryPicker stays flat.)
 */
export function requestArgs(args: Record<string, unknown>): Record<string, unknown> {
	const request = args.request;
	return typeof request === "object" && request !== null && !Array.isArray(request) ? (request as Record<string, unknown>) : args;
}

/** One projection baseline: values at an exact event cut. */
export interface ProjectionBaseline {
	asOfSeq: number;
	values: ProjectionValues;
}

/** List-row projection hints: values viewed from the persisted header cache. */
export interface ProjectionHints extends ProjectionBaseline {
	kind: "cached" | "sequenced";
}

/** Wire form of one session list row (`SessionSummary`). */
export interface SessionSummaryWire {
	agentAvailable: boolean;
	formatStatus?: "current" | "migration-required";
	sessionId: string;
	updatedAt: number;
	running: boolean;
	blank: boolean;
	parentSessionId?: string;
	origin?: "subagent";
	cwd?: string;
	projections?: ProjectionHints;
}

/** Wire form of one history record: a durable event entry. */
export interface SessionEventEntryWire {
	type: "event";
	event: WebSessionEvent;
}

/** The follow opening frame (`SessionFollowFrame` snapshot member). */
export interface FollowSnapshot {
	type: "snapshot";
	header: {
		version: number;
		id: string;
		createdAt: number;
		cwd?: string;
		parentSession?: string;
		isSeeded: boolean;
		origin?: "subagent";
	};
	cursor: number;
	records: SessionEventEntryWire[];
	hasMore: boolean;
	projections: ProjectionBaseline;
	assistantStream?: { revision: number };
}

/** Projection values seeded by a history read: title/plan/goal/imageLimits when known. */
export function projectionValuesOf(history: {
	title?: string;
	plan?: unknown;
	goal?: unknown;
	imageLimits?: unknown;
}): ProjectionValues {
	const values: ProjectionValues = {};
	if (history.title !== undefined) values.title = history.title;
	if (history.plan !== undefined) values.plan = history.plan;
	if (history.goal !== undefined) values.goal = history.goal;
	if (history.imageLimits !== undefined) values.imageLimits = history.imageLimits;
	return values;
}

/**
 * The session's current projection baseline, read without activating it
 * beyond the driver's history face. `asOfSeq` is the journal watermark the
 * values were read at (-1 for an empty log).
 */
export async function projectionsBaseline(driver: WebDriver, sessionId: string): Promise<ProjectionBaseline> {
	const history = await driver.history(sessionId, {});
	const values = projectionValuesOf(history);
	try {
		const models = await driver.models(sessionId);
		values.modelSelection = { lastUsed: models.current, next: models.current };
	} catch {
		// A session whose model face is unavailable simply omits the key.
	}
	return { asOfSeq: history.events.at(-1)?.seq ?? -1, values };
}

/** One list row, with title hints riding as cached projections when known. */
export function toSessionSummaryWire(summary: WebSessionSummary, agentAvailable: boolean): SessionSummaryWire {
	return {
		agentAvailable,
		sessionId: summary.sessionId,
		updatedAt: summary.updatedAt,
		running: summary.running,
		blank: summary.blank,
		...(summary.parentSessionId !== undefined ? { parentSessionId: summary.parentSessionId } : {}),
		...(summary.origin !== undefined ? { origin: summary.origin } : {}),
		...(summary.cwd !== undefined ? { cwd: summary.cwd } : {}),
		...(summary.title !== undefined
			? { projections: { kind: "cached" as const, asOfSeq: -1, values: { title: summary.title } } }
			: {}),
	};
}

/** `session/list` value: every persisted session, attached ones flagged. */
export async function sessionListValue(driver: WebDriver): Promise<{ items: SessionSummaryWire[] }> {
	const [sessions, attached] = await Promise.all([driver.listSessions(), driver.attachedSessions()]);
	const live = new Set(attached.map(row => row.sessionId));
	return { items: sessions.map(summary => toSessionSummaryWire(summary, live.has(summary.sessionId))) };
}

/**
 * `session/page` value: one backwards window of the journal at or below
 * `throughSeq`, paged further back by `beforeSeq` when present.
 */
export async function sessionPageValue(
	driver: WebDriver,
	args: { sessionId: string; throughSeq: number; beforeSeq?: number; maxMessages?: number },
): Promise<{ records: SessionEventEntryWire[]; hasMore: boolean }> {
	const anchor = args.beforeSeq ?? args.throughSeq + 1;
	const history = await driver.history(args.sessionId, {
		beforeSeq: anchor,
		...(args.maxMessages !== undefined ? { maxMessages: args.maxMessages } : {}),
	});
	const records = history.events
		.filter(event => event.seq <= args.throughSeq)
		.map(event => ({ type: "event" as const, event }));
	return { records, hasMore: history.hasMore };
}

/**
 * The follow opening snapshot: the newest history window, its journal
 * cursor, and the projection baseline at that cut. The assistant-stream
 * baseline starts at revision 0 with no active attempt — this host's
 * journal carries assistant output as durable events, so no process-local
 * attempt is ever in flight at snapshot time.
 */
export async function followSnapshot(
	driver: WebDriver,
	sessionId: string,
	options: { maxMessages?: number; assistantStream?: boolean } = {},
): Promise<FollowSnapshot> {
	const [history, sessions] = await Promise.all([
		driver.history(sessionId, {
			...(options.maxMessages !== undefined ? { maxMessages: options.maxMessages } : {}),
		}),
		driver.listSessions(),
	]);
	const summary = sessions.find(row => row.sessionId === sessionId);
	const values = projectionValuesOf(history);
	try {
		const models = await driver.models(sessionId);
		values.modelSelection = { lastUsed: models.current, next: models.current };
	} catch {
		// Omit the key when the model face is unavailable.
	}
	const cursor = history.events.at(-1)?.seq ?? -1;
	return {
		type: "snapshot",
		header: {
			// The translated journal's own format version (not a dsh session-format version).
			version: 1,
			id: sessionId,
			// The driver face exposes no creation time; updatedAt is the closest durable stamp.
			createdAt: summary?.updatedAt ?? 0,
			...(summary?.cwd !== undefined ? { cwd: summary.cwd } : {}),
			...(summary?.parentSessionId !== undefined ? { parentSession: summary.parentSessionId } : {}),
			isSeeded: summary?.parentSessionId !== undefined,
			...(summary?.origin !== undefined ? { origin: summary.origin } : {}),
		},
		cursor,
		records: history.events.map(event => ({ type: "event" as const, event })),
		hasMore: history.hasMore,
		projections: { asOfSeq: cursor, values },
		...(options.assistantStream === true ? { assistantStream: { revision: 0 } } : {}),
	};
}
