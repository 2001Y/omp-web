/**
 * OMP implementation of the web GUI driver interface. This is the
 * dependency-direction seam of the additive web fork: `@oh-my-pi/web` defines
 * `WebDriver`; this class implements it against the agent SDK and is injected
 * into the web server by {@link runWebMode}.
 *
 * M1 attachment model (TUI parity): one live `AgentSession` is the window.
 * Prompting a cold session switches the underlying session first; workspace
 * rows come from the session-storage cwd buckets (see the omp-web NOTES.md
 * design note).
 */

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, UserMessage } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getAgentDir, MAIN_CONFIG_FILENAMES, prompt as promptTemplate, Snowflake, VERSION } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type {
	WebAskOutcome,
	WebAskQuestion,
	WebAskRequest,
	WebCommandDescriptor,
	WebCommandExecution,
	WebDriver,
	WebGoalProjection,
	WebGoalView,
	WebHistoryNode,
	WebHistoryOptions,
	WebHistoryResult,
	WebHostDescription,
	WebImageAttachmentRef,
	WebImageLimits,
	WebJobView,
	WebModelEntry,
	WebModelReasoning,
	WebOmpSettingsCatalog,
	WebPromptOptions,
	WebPromptPart,
	WebQueueAction,
	WebQueueItem,
	WebSessionEvent,
	WebSessionSummary,
	WebSkillEntry,
	WebStreamEvent,
	WebWorkspace,
} from "@oh-my-pi/web";
import { reset as resetCapabilities } from "../../capability";
import { formatModelString } from "../../config/model-resolver";
import { getKnownRoleIds, MODEL_ROLES } from "../../config/model-roles";
import { lookup } from "../../config/registry";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { getSkillSlashCommandName } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import type { Goal, GoalModeState } from "../../goals/state";
import { cfgGoalContinuationModes, cfgGoalEnabled } from "../../goals/settings";
import { cfgPlanEnabled } from "../../plan-mode/settings";
import { resolveLocalUrlToPath } from "../../internal-urls/local-protocol";
import guidedGoalInterviewPrompt from "../../prompts/goals/guided-goal-interview.md" with { type: "text" };
import backgroundTanDispatchPrompt from "../../prompts/system/background-tan-dispatch.md" with { type: "text" };
import tanContextSwitchPrompt from "../../prompts/system/tan-context-switch.md" with { type: "text" };
import { AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import * as sdk from "../../sdk";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE } from "../../session/messages";
import { isUserQueuedMessage } from "../../session/queued-messages";
import { CURRENT_SESSION_VERSION, type FileEntry, type SessionHeader } from "../../session/session-entries";
import type { SessionInfo } from "../../session/session-listing";
import { loadSessionFile } from "../../session/session-loader";
import { cfgBranchSummaryEnabled } from "../../session/context-settings";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { createSubagentSettings } from "../../task/executor";
import { cfgTaskEnableLsp } from "../../task/settings";
import { USER_TODO_EDIT_CUSTOM_TYPE } from "../../tools/todo";
import { type VibeParentSession, VibeSessionRegistry } from "../../vibe/runtime";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitRuntime,
	parseLoopArgs,
} from "../loop-limit";
import { tryRunRpcSkillCommand } from "../rpc/rpc-mode";
import { cfgLoopMode } from "../settings";
import { collectSessionAttachments } from "./attachments";
import { forkSessionFile } from "./fork";
import { projectHistoryTree } from "./history-tree";
import { ompSettingsCatalog } from "./omp-settings";
import {
	COMMAND_ENTRY_TYPE,
	commandRecordOf,
	type HistoryItem,
	mapUserMessage,
	SessionEventTranslator,
} from "./translate";
import type { WebInteractionAsker } from "./ui-context";
import { WorkspaceOverrides } from "./workspace-state";

/** Slash names the dsh client serves itself; a host duplicate breaks its menu. */
const CLIENT_OWNED_COMMANDS: Record<string, true> = { model: true };

/** Session-search result cap (the dsh wire limit). */
const SESSION_SEARCH_LIMIT = 20;

/** Snippet code-point budget (the dsh wire limit). */
const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240;

/** Per-file size cap for the deep search pass (bounds the raw full-text scan). */
const SESSION_SEARCH_DEEP_MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Best-effort JSON escape cleanup for raw-log search snippets (display only;
 * the match itself is located in the uncleaned text first).
 */
function cleanJsonSnippet(text: string): string {
	return text
		.replace(/\\n/g, " ")
		.replace(/\\t/g, " ")
		.replace(/\\"/g, '"')
		.replace(/\\\//g, "/")
		.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/\\\\/g, "\\");
}

/** Extract a bounded snippet around one match (code-point safe). */
function snippetAround(haystack: string, index: number, needleLength: number): string {
	const points = [...haystack];
	// The index arrived in UTF-16 units; locate the code-point offset.
	const pointIndex = [...haystack.slice(0, index)].length;
	const start = Math.max(0, pointIndex - Math.floor(SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS / 2));
	const end = Math.min(points.length, start + SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS);
	const sliced = points.slice(start, end).join("");
	// Re-center on the match when the window shifted.
	if (end - start >= SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS && pointIndex + needleLength > end) {
		const shifted = Math.min(points.length - SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS, pointIndex);
		return points.slice(Math.max(0, shifted), Math.max(0, shifted) + SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS).join("");
	}
	return sliced;
}

/** Narrow a persisted modeData.previousTools payload onto a tool-name list. */
function readPersistedToolNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	if (!value.every(name => typeof name === "string")) return undefined;
	return value as string[];
}

/** Rebuild the goal payload persisted in a goal/goal_paused mode_change entry. */
function goalFromModeData(modeData: Record<string, unknown> | undefined): Goal | undefined {
	const goal = modeData?.goal;
	if (goal === undefined || goal === null || typeof goal !== "object") return undefined;
	const value = goal as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status as Goal["status"],
		...(typeof value.tokenBudget === "number" ? { tokenBudget: value.tokenBudget } : {}),
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

/**
 * The listing's empty-corpus placeholder (session-listing.ts fills
 * `firstMessage` with it when a session has no usable first prompt) is a UI
 * string, not a title — surfacing it names the row "(no messages)" and fork
 * children inherit it with a " (1)" suffix. Treat it as untitled so the
 * client's own fallback (cwd basename) applies.
 */
const NO_MESSAGES_PLACEHOLDER = "(no messages)";

/** Title fallback from the listing's first-message preview; undefined when untitled. Exported for the web-mode contract tests. */
export function titleFromFirstMessage(firstMessage: string | undefined): string | undefined {
	if (firstMessage === undefined) return undefined;
	const trimmed = firstMessage.trim();
	if (trimmed === "" || trimmed === NO_MESSAGES_PLACEHOLDER) return undefined;
	return trimmed.slice(0, 60);
}

/** Strip ANSI escapes: builtin command output is styled for terminals, the web command card renders plain text. */
function stripAnsi(text: string): string {
	return text.replace(/\[[0-9;]*m/gu, "");
}

/** Path segments that would mutate a prototype chain (prototype pollution). */
// `["__proto__"]` computed syntax creates an own property; the bare literal
// key would set the object's prototype instead. The boolean value type:
// `constructor`/`prototype` keys defeat TS's literal-true narrowing.
const UNSAFE_PATH_SEGMENTS: Record<string, boolean> = { ["__proto__"]: true, constructor: true, prototype: true };

/** Apply one set/unset op at a nested path inside a plain-object tree. */
function applyNestedOp(
	root: Record<string, unknown>,
	op: { op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] },
): void {
	let node = root;
	for (const segment of op.path.slice(0, -1)) {
		const child = node[segment];
		if (typeof child !== "object" || child === null || Array.isArray(child)) {
			// A non-object intermediate blocks descent: replace it (set) or stop
			// (unset has nothing to remove below a scalar).
			if (op.op === "unset") return;
			const fresh: Record<string, unknown> = {};
			node[segment] = fresh;
			node = fresh;
		} else {
			node = child as Record<string, unknown>;
		}
	}
	const leaf = op.path[op.path.length - 1]!;
	if (op.op === "set") node[leaf] = op.value;
	else delete node[leaf];
}

/** Fold raw session entries into interleaved history items (messages + commands). */
/**
 * The active branch (root → leaf) of a session tree — the only entries that
 * are real conversation context. Everything else is forked history the
 * transcript must not include (OMP sessions are git-like trees; the leaf's
 * ancestor chain is the current conversation).
 */
export function currentBranchOf(entries: ReadonlyArray<FileEntry>): FileEntry[] {
	const byId = new Map(entries.map(entry => [entry.id, entry] as const));
	const chain: FileEntry[] = [];
	const seen = new Set<string>();
	let cursor: FileEntry | undefined = entries.at(-1);
	while (cursor !== undefined && !seen.has(cursor.id)) {
		seen.add(cursor.id);
		chain.push(cursor);
		const parentId = (cursor as { parentId?: string | null }).parentId;
		cursor = parentId != null ? byId.get(parentId) : undefined;
	}
	return chain.reverse();
}

export function historyItemsOf(entries: ReadonlyArray<FileEntry>): HistoryItem[] {
	const branch = currentBranchOf(entries);
	// /clear parity: the collapsed transcript (and the model context) starts
	// after the latest reset_boundary; the pre-clear entries stay in the file
	// and the history tree but no longer surface in the chat fold.
	let resetCut = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "reset_boundary") {
			resetCut = i;
			break;
		}
	}
	const items: HistoryItem[] = [];
	for (const entry of branch.slice(resetCut + 1)) {
		if (entry.type === "message") {
			items.push({ kind: "message", message: entry.message });
		} else {
			const record = commandRecordOf(entry);
			if (record !== undefined) {
				const time = Number.isNaN(Date.parse(entry.timestamp)) ? Date.now() : Date.parse(entry.timestamp);
				items.push({ kind: "command", record, time });
			}
		}
	}
	return items;
}

/**
 * Page the message-boundary window (mirrors the host contract the client
 * loads against): count `maxMessages` message events backwards from the end,
 * then cut at a top-level boundary (turn/start or a command record) so a page
 * never starts mid-turn. Exported for the web-mode contract tests.
 */
export function pageHistory(
	events: WebSessionEvent[],
	options: WebHistoryOptions,
): { events: WebSessionEvent[]; hasMore: boolean } {
	const beforeSeq = options.beforeSeq;
	const pool = beforeSeq !== undefined ? events.filter(event => event.seq < beforeSeq) : events;
	if (pool.length === 0) return { events: [], hasMore: false };
	const budget = options.maxMessages ?? 50;
	const isMessage = (event: WebSessionEvent): boolean =>
		event.type === "user/message" || event.type === "assistant/message" || event.type === "tool/result";
	let count = 0;
	let messageCut = 0;
	for (let i = pool.length - 1; i >= 0; i--) {
		if (isMessage(pool[i])) count++;
		if (count > budget) {
			messageCut = i + 1;
			break;
		}
	}
	// Cut at a top-level boundary (turn/start or command/run) so a page never
	// starts mid-turn. Scan forward from the message cut first; when the cut
	// sits inside an over-budget turn no boundary exists before the pool end —
	// an empty page there would soft-lock the client's load-older (and blank
	// the initial page when the LATEST turn is the giant one), so extend the
	// window back to that turn's start instead.
	let cut = messageCut;
	while (cut < pool.length && pool[cut].type !== "turn/start" && pool[cut].type !== "command/run") cut++;
	if (cut === pool.length && messageCut > 0) {
		// Backward: land ON the containing turn's first event (the largest index
		// at or below the message cut that opens a turn/command).
		cut = Math.min(messageCut, pool.length - 1);
		while (cut > 0 && pool[cut].type !== "turn/start" && pool[cut].type !== "command/run") cut--;
	}
	return { events: pool.slice(cut), hasMore: cut > 0 };
}

/** The backend the omp web GUI host drives. */
export class OmpWebDriver implements WebDriver, WebInteractionAsker {
	readonly #session: AgentSession;
	readonly #translator = new SessionEventTranslator();
	readonly #listeners = new Set<(event: WebStreamEvent) => void>();
	#running = false;
	#sessionListCache: Promise<SessionInfo[]> | undefined;
	#attachInFlight: Promise<void> | undefined;
	#queueSignature = "";
	#jobsSignature = "";
	readonly #queueIds = new WeakMap<AgentMessage, string>();
	#planModePreviousTools: string[] | undefined;
	#vibePreviousTools: string[] | undefined;
	/** Last derived title already projected (idempotence guard). */
	#projectedDerivedTitle: string | undefined;
	/** Sidebar display overrides (archived ids, renames, drag orders). */
	readonly #overrides = new WorkspaceOverrides(path.join(getAgentDir(), "web-workspaces.json"));
	/** CAS revision per goal id (in-memory; every durable mutation bumps it). */
	readonly #goalRevisions = new Map<string, number>();
	/** Loop-mode state (the /loop bridge; TUI loopMode* fields). */
	#loopEnabled = false;
	#loopPrompt: string | undefined;
	#loopLimit: LoopLimitRuntime | undefined;
	#loopTimer: NodeJS.Timeout | undefined;
	/** Goal-continuation scheduling state (the TUI #scheduleGoalContinuation mirror). */
	#goalContinuationTimer: NodeJS.Timeout | undefined;
	#goalContinuationTurnInFlight = false;
	#goalSuppressNextContinuation = false;
	#goalTurnHadToolCalls = false;
	/** Open synthetic command cards for session-level signals (retry/compaction). */
	#retryCommandId: string | undefined;
	#compactionCommandId: string | undefined;

	constructor(session: AgentSession) {
		this.#session = session;
		this.#translator.adoptEntries(session.sessionManager.getBranch());
		// switchSession restores messages/model but never the mode fields; the
		// reconciler hook is the seam the TUI uses for the same job.
		session.setSessionSwitchReconciler(() => this.#reconcileModesFromSession());
		void this.#reconcileModesFromSession().catch(error => {
			logger.warn(`omp-web: boot mode reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
		});
		session.subscribe(event => this.#onAgentEvent(event));
		session.subscribeCommandMetadataChanged(() => {
			this.#sessionListCache = undefined;
			this.#emit({ kind: "commands-changed" });
		});
		// Auto-generated titles (and renames from any path) must reach the
		// sidebar without a list repull: broadcast the title projection — the
		// same frame the rename RPC emits — whenever the name settles.
		session.sessionManager.onSessionNameChanged(() => {
			this.#sessionListCache = undefined;
			const title = this.#session.sessionManager.getSessionName();
			if (title === undefined) return;
			this.#emit({
				kind: "session-projection",
				sessionId: this.#session.sessionId,
				key: "title",
				value: title,
				seq: this.#translator.nextSeq(),
			});
		});
	}

	#emit(notification: WebStreamEvent): void {
		for (const listener of this.#listeners) {
			try {
				listener(notification);
			} catch (error) {
				logger.warn(`omp-web: stream listener threw: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	#onAgentEvent(event: AgentSessionEvent): void {
		const sessionId = this.#session.sessionId;
		if (event.type === "agent_start" && !this.#running) {
			this.#running = true;
			this.#goalTurnHadToolCalls = false;
			this.#cancelGoalContinuation();
			this.#emit({ kind: "session-status", sessionId, running: true });
		}
		// Session-level signals with no message seat surface as ephemeral
		// command cards (the TUI shows them as transcript status lines).
		if (event.type === "tool_execution_start") {
			this.#goalTurnHadToolCalls = true;
		}
		if (event.type === "auto_retry_start" && this.#retryCommandId === undefined) {
			const commandId = `retry-${crypto.randomUUID()}`;
			this.#retryCommandId = commandId;
			const detail = `attempt ${event.attempt}${event.maxAttempts !== undefined ? `/${event.maxAttempts}` : ""}${
				event.errorMessage !== undefined && event.errorMessage !== "" ? `: ${event.errorMessage}` : ""
			}`;
			this.#emitCommandEvent(sessionId, this.#translator.appendCommandRun(commandId, "retry", detail));
		}
		if (event.type === "auto_retry_end" && this.#retryCommandId !== undefined) {
			const commandId = this.#retryCommandId;
			this.#retryCommandId = undefined;
			this.#emitCommandEvent(
				sessionId,
				this.#translator.appendCommandDone(
					commandId,
					event.success ? "success" : "error",
					event.success ? "retry succeeded" : (event.finalError ?? "retry exhausted"),
				),
			);
		}
		if (event.type === "auto_compaction_start" && this.#compactionCommandId === undefined) {
			const commandId = `compaction-${crypto.randomUUID()}`;
			this.#compactionCommandId = commandId;
			this.#emitCommandEvent(sessionId, this.#translator.appendCommandRun(commandId, "auto-compact", ""));
		}
		if (event.type === "auto_compaction_end" && this.#compactionCommandId !== undefined) {
			const commandId = this.#compactionCommandId;
			this.#compactionCommandId = undefined;
			const text = event.aborted
				? "auto-compaction aborted"
				: event.skipped === true
					? "auto-compaction skipped"
					: event.result !== undefined
						? `compacted ${event.result.tokensBefore} tokens`
						: (event.errorMessage ?? "auto-compaction finished");
			this.#emitCommandEvent(
				sessionId,
				this.#translator.appendCommandDone(commandId, event.aborted ? "error" : "success", text),
			);
		}
		if (event.type === "notice") {
			const commandId = `notice-${crypto.randomUUID()}`;
			this.#emitCommandEvent(sessionId, this.#translator.appendCommandRun(commandId, "notice", event.level));
			this.#emitCommandEvent(
				sessionId,
				this.#translator.appendCommandDone(commandId, event.level === "error" ? "error" : "success", event.message),
			);
		}
		if (event.type === "goal_updated") {
			// The goal tool mutated the durable state: re-project from the EVENT
			// payload (a drop emits before the state clears, so the session state
			// still reads active at this point).
			if (event.goal !== null) this.#bumpGoalRevision(event.goal);
			this.#emitGoalProjection(event.state);
			if (event.state === undefined || event.goal === null) this.#emitGoalProjection();
		}
		if (event.type === "agent_end") {
			if (this.#running) {
				this.#running = false;
				this.#emit({ kind: "session-status", sessionId, running: false });
			}
			// Derived titles (the first user message — the listing fallback
			// when no auto/explicit title exists) settle once the turn's
			// messages are in. Project them so the sidebar names the session
			// without a list repull; an explicit session name still wins.
			const derived = this.#titleOfCurrent();
			if (
				derived !== undefined &&
				derived !== this.#projectedDerivedTitle &&
				!this.#session.sessionManager.getSessionName()
			) {
				this.#projectedDerivedTitle = derived;
				this.#sessionListCache = undefined;
				this.#emit({
					kind: "session-projection",
					sessionId,
					key: "title",
					value: derived,
					seq: this.#translator.nextSeq(),
				});
			}
			// Goal-continuation bookkeeping mirrors the TUI handler: a
			// continuation turn that ended without tool calls suppresses the
			// next tick (idle-loop guard).
			if (this.#goalContinuationTurnInFlight) {
				this.#goalSuppressNextContinuation = !this.#goalTurnHadToolCalls;
				this.#goalContinuationTurnInFlight = false;
			}
			// The goal tool's completion marks the state exiting; the mode
			// teardown lands at the turn boundary (TUI #handleGoalSessionEvent).
			if (this.#session.getGoalModeState()?.mode === "exiting") {
				const exiting = this.#session.getGoalModeState()?.goal;
				if (exiting !== undefined) this.#bumpGoalRevision(exiting);
				void this.#exitGoalMode("completed", exiting).catch(error => {
					logger.warn(`omp-web: goal-mode exit failed: ${error instanceof Error ? error.message : String(error)}`);
				});
			}
			this.#scheduleLoopAutoSubmit();
			this.#scheduleGoalContinuation();
		}
		for (const translated of this.#translator.translate(event)) {
			this.#emit({ kind: "session-event", sessionId, event: translated });
		}
		// Queue drain/clear rides agent lifecycle events; the snapshot diff
		// makes the emit idempotent. Jobs settle on the same boundaries.
		this.#syncQueue();
		this.#syncJobs();
	}

	/** The /loop auto-submit tick (TUI #scheduleLoopAutoSubmit mirror). */
	#scheduleLoopAutoSubmit(): void {
		if (this.#loopTimer !== undefined) {
			clearTimeout(this.#loopTimer);
			this.#loopTimer = undefined;
		}
		if (!this.#loopEnabled || this.#loopPrompt === undefined) return;
		if (isLoopDurationExpired(this.#loopLimit)) {
			this.#disableLoop("Loop time limit reached. Loop mode disabled.");
			return;
		}
		const prompt = this.#loopPrompt;
		this.#loopTimer = setTimeout(() => {
			this.#loopTimer = undefined;
			if (!this.#loopEnabled || this.#loopPrompt !== prompt) return;
			if (this.#session.isStreaming || this.#session.isCompacting || this.#session.hasPostPromptWork) {
				this.#scheduleLoopAutoSubmit();
				return;
			}
			if (isLoopDurationExpired(this.#loopLimit)) {
				this.#disableLoop("Loop time limit reached. Loop mode disabled.");
				return;
			}
			if (!consumeLoopLimitIteration(this.#loopLimit)) {
				this.#disableLoop("Loop count limit reached. Loop mode disabled.");
				return;
			}
			void this.#session.prompt(prompt, { streamingBehavior: "followUp" }).catch(error => {
				logger.warn(`omp-web: loop iteration failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, 800);
	}

	/** Turn loop mode off and surface the reason as a command card. */
	#disableLoop(reason: string): void {
		this.#loopEnabled = false;
		this.#loopPrompt = undefined;
		this.#loopLimit = undefined;
		if (this.#loopTimer !== undefined) {
			clearTimeout(this.#loopTimer);
			this.#loopTimer = undefined;
		}
		const sessionId = this.#session.sessionId;
		const commandId = `loop-${crypto.randomUUID()}`;
		this.#emitCommandEvent(sessionId, this.#translator.appendCommandRun(commandId, "loop", ""));
		this.#emitCommandEvent(sessionId, this.#translator.appendCommandDone(commandId, "success", reason));
	}

	/** Cancel a pending goal-continuation tick. */
	#cancelGoalContinuation(): void {
		if (this.#goalContinuationTimer !== undefined) {
			clearTimeout(this.#goalContinuationTimer);
			this.#goalContinuationTimer = undefined;
		}
	}

	/**
	 * The goal-continuation engine (TUI #scheduleGoalContinuation mirror): an
	 * active goal keeps the agent working between turns with a hidden
	 * continuation prompt. The web host counts as an "interactive" mode for
	 * the goal.continuationModes setting (it IS the interactive UI).
	 */
	#scheduleGoalContinuation(): void {
		this.#cancelGoalContinuation();
		if (this.#loopEnabled) return;
		if (!cfgGoalContinuationModes.get(this.#session.settings).includes("interactive")) return;
		if (this.#session.getPlanModeState() !== undefined) return;
		if (this.#goalSuppressNextContinuation) return;
		const state = this.#session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return;
		const prompt = this.#session.goalRuntime.buildContinuationPrompt();
		if (prompt === undefined) return;
		this.#goalContinuationTimer = setTimeout(() => {
			this.#goalContinuationTimer = undefined;
			if (this.#session.isStreaming || this.#session.isCompacting || this.#session.hasPostPromptWork) {
				this.#scheduleGoalContinuation();
				return;
			}
			const latest = this.#session.getGoalModeState();
			if (!latest?.enabled || latest.goal.status !== "active") return;
			this.#goalContinuationTurnInFlight = true;
			void this.#session
				.promptCustomMessage(
					{
						customType: "goal-continuation",
						content: prompt,
						display: false,
						attribution: "agent",
					},
					{ streamingBehavior: "followUp" },
				)
				.catch(error => {
					this.#goalContinuationTurnInFlight = false;
					logger.warn(
						`omp-web: goal continuation failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				});
		}, 800);
	}

	async askApproval(approval: { toolName: string; reason?: string }): Promise<"allowed-once" | "rejected"> {
		const outcome = await this.#ask({ kind: "approval", approval: { approvalId: crypto.randomUUID(), ...approval } });
		return outcome.kind === "approval" ? outcome.outcome : "rejected";
	}

	async askQuestions(questions: WebAskQuestion[]): Promise<import("@oh-my-pi/web").WebAskAnswer | undefined> {
		const outcome = await this.#ask({ kind: "question", questions });
		return outcome.kind === "question" ? outcome.answer : undefined;
	}

	/** Surface one extension notice as an ephemeral transcript card. */
	notify(message: string, level: "info" | "warning" | "error"): void {
		const sessionId = this.#session.sessionId;
		const commandId = `notice-${crypto.randomUUID()}`;
		this.#emitCommandEvent(sessionId, this.#translator.appendCommandRun(commandId, "notice", level));
		this.#emitCommandEvent(
			sessionId,
			this.#translator.appendCommandDone(commandId, level === "error" ? "error" : "success", message),
		);
	}

	/** Park one ask on the stream until the web host resolves it via /api/respond. */
	#ask(request: WebAskRequest): Promise<WebAskOutcome> {
		return new Promise<WebAskOutcome>((resolve, reject) => {
			this.#emit({
				kind: "ask-requested",
				sessionId: this.#session.sessionId,
				rpcId: crypto.randomUUID(),
				request,
				settle: outcome => resolve(outcome),
				fail: error => reject(error),
			});
		});
	}

	async describeHost(): Promise<WebHostDescription> {
		const model = this.#session.model;
		return {
			version: VERSION,
			cwd: this.#session.sessionManager.getCwd(),
			home: os.homedir(),
			...(model !== undefined ? { provider: model.provider, model: model.id } : {}),
			attachedSessions: (await this.attachedSessions()).length,
			// host.openPath is not implemented; settings.openDocument is the one
			// document-opening surface (it uses the platform opener directly).
			canOpenPath: false,
		};
	}

	/** All persisted sessions across every project bucket (listAll is cross-project). */
	async #allSessionInfos(): Promise<SessionInfo[]> {
		this.#sessionListCache ??= SessionManager.listAll().catch(error => {
			this.#sessionListCache = undefined;
			throw error;
		});
		return this.#sessionListCache;
	}

	async listWorkspaces(): Promise<{ workspaces: WebWorkspace[]; archivedSessionIds: string[] }> {
		const infos = await this.#allSessionInfos();
		const currentCwd = this.#session.sessionManager.getCwd();
		const byCwd = new Map<string, { sessionIds: string[]; latest: number }>();
		for (const info of infos) {
			if (info.cwd === "") continue;
			const bucket = byCwd.get(info.cwd) ?? { sessionIds: [], latest: 0 };
			bucket.sessionIds.push(info.id);
			bucket.latest = Math.max(bucket.latest, info.modified.getTime());
			byCwd.set(info.cwd, bucket);
		}
		// The attached session always belongs to its bucket even before a
		// listing picks it up.
		const currentBucket = byCwd.get(currentCwd);
		const currentId = this.#session.sessionId;
		if (currentBucket !== undefined && !currentBucket.sessionIds.includes(currentId)) {
			currentBucket.sessionIds.unshift(currentId);
		}
		// Planned (possibly empty) workspaces the user adopted through the GUI
		// surface even before any session lands in their bucket.
		for (const planned of this.#overrides.plannedWorkspaces()) {
			if (!byCwd.has(planned)) byCwd.set(planned, { sessionIds: [], latest: 0 });
		}
		const recency = [...byCwd.entries()].sort((left, right) => {
			if (left[0] === currentCwd) return -1;
			if (right[0] === currentCwd) return 1;
			return right[1].latest - left[1].latest;
		});
		const ordered = this.#overrides.applyWorkspaceOrder(recency.map(([cwd]) => cwd));
		const workspaces: WebWorkspace[] = ordered.map(cwd => {
			const bucket = byCwd.get(cwd) ?? { sessionIds: [], latest: 0 };
			return {
				workspaceId: cwd,
				path: cwd,
				title: this.#overrides.workspaceTitle(cwd) ?? cwd.split("/").filter(Boolean).at(-1) ?? cwd,
				sessionIds: this.#overrides.applySessionOrder(cwd, bucket.sessionIds),
				updatedAt: bucket.latest,
			};
		});
		return { workspaces, archivedSessionIds: this.#overrides.archivedSessionIds() };
	}

	/** The sidebar title of one session info (TUI parity: title, else first prompt). */
	#titleOfInfo(info: SessionInfo): string | undefined {
		if (info.title !== undefined && info.title !== "") return info.title;
		return titleFromFirstMessage(info.firstMessage);
	}

	async listSessions(): Promise<WebSessionSummary[]> {
		const infos = await this.#allSessionInfos();
		const currentId = this.#session.sessionId;
		const summaries = infos.map(info => ({
			sessionId: info.id,
			updatedAt: info.modified.getTime(),
			running: info.id === currentId && (this.#running || this.#session.isStreaming),
			blank: info.messageCount === 0,
			...(info.cwd !== "" ? { cwd: info.cwd } : {}),
			...(this.#titleOfInfo(info) !== undefined ? { title: this.#titleOfInfo(info) } : {}),
		}));
		if (!summaries.some(summary => summary.sessionId === currentId)) {
			summaries.unshift({
				sessionId: currentId,
				updatedAt: Date.now(),
				running: this.#running || this.#session.isStreaming,
				blank: this.#session.messages.length === 0,
				cwd: this.#session.sessionManager.getCwd(),
				...(this.#titleOfCurrent() !== undefined ? { title: this.#titleOfCurrent() } : {}),
			});
		}
		// The web session list renders updatedAt descending; pinned-first TUI
		// ordering is a terminal-surface concern and stays here.
		return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
	}

	async createSession(options: { workspaceId?: string }): Promise<{ sessionId: string }> {
		const currentCwd = this.#session.sessionManager.getCwd();
		if (options.workspaceId !== undefined && options.workspaceId !== currentCwd) {
			// A "+" in another workspace mints a parked blank session file under
			// that bucket without disturbing the attached session (the client
			// lists it immediately; opening it attaches via history()).
			const target = path.resolve(options.workspaceId);
			const stats = await stat(target).catch(() => undefined);
			if (stats === undefined || !stats.isDirectory()) {
				throw new Error(`omp-web: no such workspace directory: ${target}`);
			}
			const sessionDir = SessionManager.getDefaultSessionDir(target, getAgentDir());
			await mkdir(sessionDir, { recursive: true });
			const timestamp = new Date().toISOString();
			const sessionId = crypto.randomUUID();
			const header: SessionHeader = {
				type: "session",
				version: CURRENT_SESSION_VERSION,
				id: sessionId,
				timestamp,
				cwd: target,
			};
			await writeFile(
				path.join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`),
				`${JSON.stringify(header)}\n`,
			);
			this.#sessionListCache = undefined;
			this.#emit({ kind: "session-added", sessionId, blank: true, cwd: target });
			return { sessionId };
		}
		if (this.#session.isStreaming || this.#session.isCompacting) {
			throw new Error("omp-web: the attached session is busy; cancel it before creating a new one");
		}
		if (this.#session.messages.length === 0) {
			return { sessionId: this.#session.sessionId };
		}
		const switched = await this.#session.newSession();
		if (!switched) {
			throw new Error("omp-web: newSession was refused");
		}
		// newSession does not ride the switch reconciler; a fresh session must
		// not inherit the old one's plan/vibe/goal state.
		await this.#reconcileModesFromSession();
		// Seed from the ACTIVE BRANCH only — every other entry is forked history.
		this.#translator.adoptEntries(this.#session.sessionManager.getBranch());
		this.#sessionListCache = undefined;
		const sessionId = this.#session.sessionId;
		// The window moved: re-baseline the client's session runtime.
		this.#emit({
			kind: "session-attached",
			sessionId,
			lastSeq: this.#translator.lastSeq,
			queue: this.#queueSnapshot(),
			jobs: this.#jobsSnapshot(),
		});
		this.#emit({ kind: "session-added", sessionId, blank: true, cwd: currentCwd });
		return { sessionId };
	}

	async history(sessionId: string, options: WebHistoryOptions): Promise<WebHistoryResult> {
		if (sessionId !== this.#session.sessionId) {
			// Opening a cold session attaches it (the window moves with the UI —
			// commands, models, and prompts then serve that session). A busy
			// refusal falls through to the read-only cold-file view below.
			try {
				await this.#ensureAttached(sessionId);
			} catch (error) {
				logger.warn(
					`omp-web: cold-open attach fell back to file view: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		let events: WebSessionEvent[];
		let title: string | undefined;
		if (sessionId === this.#session.sessionId) {
			// The attached session serves from the translator's canonical log so
			// history and live events share one seq space within the epoch.
			events = [...this.#translator.log];
			title = this.#titleOfCurrent();
		} else {
			const infos = await this.#allSessionInfos();
			const info = infos.find(candidate => candidate.id === sessionId);
			if (info === undefined) {
				throw new Error(`omp-web: no persisted session ${sessionId}`);
			}
			const loaded = await loadSessionFile(info.path, new FileSessionStorage());
			events = new SessionEventTranslator().translateItems(historyItemsOf(loaded.entries));
			title = this.#titleOfInfo(info);
		}
		// The plan baseline reads the folded log (not the live session state):
		// attaching a persisted session does not rehydrate the agent-side mode,
		// while the mode_change entries folded into every log path do carry it.
		const lastFlip = events.findLast(
			(event): event is Extract<WebSessionEvent, { type: "plan/mode" }> => event.type === "plan/mode",
		);
		const plan = lastFlip?.data.active ? { active: true, pending: false } : undefined;
		const goal = this.#goalProjection();
		return {
			...pageHistory(events, options),
			...(title !== undefined ? { title } : {}),
			...(plan !== undefined ? { plan } : {}),
			...(goal !== null ? { goal } : {}),
			imageLimits: this.#imageLimits(),
		};
	}

	async prompt(sessionId: string, content: WebPromptPart[], options?: WebPromptOptions): Promise<void> {
		await this.#ensureAttached(sessionId);
		const text = content
			.map(part => (part.type === "text" ? part.text : ""))
			.filter(text => text !== "")
			.join("\n");
		const images: ImageContent[] = content
			.filter((part): part is Extract<WebPromptPart, { type: "image" }> => part.type === "image")
			.map(part => ({ type: "image" as const, data: part.data, mimeType: part.mediaType }));
		if (text === "" && images.length === 0) {
			throw new Error("omp-web: prompt carried no text or image parts");
		}
		// Streaming delivery maps 1:1 onto the backend queue semantics: steer
		// interrupts the running turn, queue lands as a follow-up. Without the
		// streamingBehavior option a running session rejects the prompt.
		const streamingBehavior = options?.mode === "steer" ? ("steer" as const) : ("followUp" as const);
		// /loop parity: the first prompt after /loop arms the repeat payload
		// (TUI setCurrentPrompt on the next input).
		if (this.#loopEnabled && this.#loopPrompt === undefined && !text.startsWith("/")) {
			this.#loopPrompt = text;
		}
		// Fire-and-forget: the wire contract answers admission, and the turn
		// streams through the event channel.
		void this.#session
			.prompt(text, {
				streamingBehavior,
				...(images.length > 0 ? { images } : {}),
			})
			.then(() => {
				this.#syncQueue();
			})
			.catch(error => {
				// Admission answered but delivery failed afterwards: surface the
				// rejection in the transcript as a failed command lifecycle or
				// the user's message vanishes with only a server-log line.
				const message = error instanceof Error ? error.message : String(error);
				const commandId = `prompt-${crypto.randomUUID()}`;
				this.#emitCommandEvent(sessionId, this.#translator.appendCommandRun(commandId, "prompt", text));
				this.#emitCommandEvent(sessionId, this.#translator.appendCommandDone(commandId, "error", message));
				this.#syncQueue();
				logger.warn(`omp-web: prompt failed: ${message}`);
			});
	}

	async updateQueue(sessionId: string, itemId: string, action: WebQueueAction): Promise<void> {
		await this.#ensureAttached(sessionId);
		const agent = this.#session.agent;
		const steering = [...agent.peekSteeringQueue()];
		const followUp = [...agent.peekFollowUpQueue()];
		const inSteering = steering.findIndex(message => this.#queueIdOf(message) === itemId);
		const inFollowUp = followUp.findIndex(message => this.#queueIdOf(message) === itemId);
		if (inSteering === -1 && inFollowUp === -1) {
			throw new Error(`omp-web: queue item ${itemId} is not pending`);
		}
		if (action.kind === "remove") {
			if (inSteering !== -1) steering.splice(inSteering, 1);
			else followUp.splice(inFollowUp, 1);
		} else if (action.kind === "edit") {
			const target = inSteering !== -1 ? steering[inSteering]! : followUp[inFollowUp]!;
			const edited: AgentMessage = {
				...target,
				content: action.content.map(part =>
					part.type === "text"
						? { type: "text" as const, text: part.text }
						: { type: "image" as const, data: part.data, mimeType: part.mediaType },
				),
			} as AgentMessage;
			// The replacement object takes over the edited item's wire identity.
			this.#queueIds.set(edited, itemId);
			if (inSteering !== -1) steering[inSteering] = edited;
			else followUp[inFollowUp] = edited;
		} else if (action.kind === "steer") {
			// Only a queued follow-up can be promoted to steering.
			if (inFollowUp === -1) {
				throw new Error(`omp-web: queue item ${itemId} is already steering`);
			}
			const [moved] = followUp.splice(inFollowUp, 1);
			steering.push(moved!);
		}
		agent.replaceQueues(steering, followUp);
		this.#syncQueue();
	}

	async queuedMessages(sessionId: string): Promise<WebQueueItem[]> {
		if (sessionId !== this.#session.sessionId) return [];
		return this.#queueSnapshot();
	}

	async sessionJobs(sessionId: string): Promise<WebJobView[]> {
		if (sessionId !== this.#session.sessionId) return [];
		return this.#jobsSnapshot();
	}

	/**
	 * Stable wire identity for one queued message object. Queued user messages
	 * carry no durable id of their own, so identity is object-stable: the same
	 * object maps to the same id for its whole queue residency ( WeakMap entry
	 * dies with the object when the agent drains it).
	 */
	#queueIdOf(message: AgentMessage): string {
		let id = this.#queueIds.get(message);
		if (id === undefined) {
			id = crypto.randomUUID();
			this.#queueIds.set(message, id);
		}
		return id;
	}

	/** The wire queue snapshot over the session's pending user messages. */
	#queueSnapshot(): WebQueueItem[] {
		const agent = this.#session.agent;
		const items: WebQueueItem[] = [];
		const push = (message: AgentMessage, placement: "steering" | "queued"): void => {
			if (!isUserQueuedMessage(message)) return;
			items.push({ id: this.#queueIdOf(message), placement, message: mapUserMessage(message as UserMessage) });
		};
		for (const message of agent.peekSteeringQueue()) push(message, "steering");
		for (const message of agent.peekFollowUpQueue()) push(message, "queued");
		return items;
	}

	/** Emit the queue snapshot when its pending ids changed since the last emit. */
	#syncQueue(): void {
		const items = this.#queueSnapshot();
		const signature = items.map(item => `${item.id}:${item.placement}`).join(",");
		if (signature === this.#queueSignature) return;
		this.#queueSignature = signature;
		this.#emit({ kind: "session-queue", sessionId: this.#session.sessionId, items });
	}

	/** The session's current background-job rows (the session/jobs wire view). */
	#jobsSnapshot(): WebJobView[] {
		const manager = this.#session.asyncJobManager;
		if (manager === undefined) return [];
		return manager.getAllJobs().map(job => ({
			id: job.id,
			kind: job.type,
			label: job.label,
			status:
				job.status === "running"
					? ("running" as const)
					: job.status === "completed"
						? ("completed" as const)
						: job.status === "failed"
							? ("failed" as const)
							: ("killed" as const),
			startedAt: job.startTime,
			...(job.status !== "running" ? { finishedAt: Date.now() } : {}),
		}));
	}

	/** Emit the jobs snapshot when it changed (same diff discipline as the queue). */
	#syncJobs(): void {
		const jobs = this.#jobsSnapshot();
		const signature = jobs.map(job => `${job.id}:${job.status}:${job.finishedAt ?? 0}`).join(",");
		if (signature === this.#jobsSignature) return;
		this.#jobsSignature = signature;
		this.#emit({ kind: "session-jobs", sessionId: this.#session.sessionId, jobs });
	}

	async models(sessionId: string): Promise<import("@oh-my-pi/web").WebSessionModels> {
		await this.#ensureAttached(sessionId);
		const current = this.#session.model;
		const available = this.#session.getAvailableModels();
		const byProvider = new Map<string, { id: string; name: string; models: WebModelEntry[] }>();
		for (const model of available) {
			const group = byProvider.get(model.provider) ?? { id: model.provider, name: model.provider, models: [] };
			group.models.push({ id: model.id, name: model.name ?? model.id });
			byProvider.set(model.provider, group);
		}
		const configured = this.#session.configuredThinkingLevel();
		const reasoning: WebModelReasoning = {
			efforts: THINKING_EFFORTS.map(effort => ({ id: effort as string, name: effort as string })),
			...(configured !== "auto" && configured ? { defaultEffort: configured as string } : {}),
		};
		for (const group of byProvider.values()) {
			for (const model of group.models) model.reasoning = reasoning;
		}
		return {
			current: {
				provider: current?.provider ?? "",
				model: current?.id ?? "",
				...(configured && configured !== "auto" ? { reasoningEffort: configured as string } : {}),
			},
			routable: current !== undefined,
			groups: [...byProvider.values()],
		};
	}

	async selectModel(
		sessionId: string,
		selection: { provider: string; model: string; reasoningEffort?: string },
	): Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }> {
		await this.#ensureAttached(sessionId);
		const target = this.#session
			.getAvailableModels()
			.find(model => model.provider === selection.provider && model.id === selection.model);
		if (target === undefined) {
			throw new Error(`omp-web: model ${selection.provider}/${selection.model} is not available`);
		}
		const thinkingLevel = selection.reasoningEffort as ThinkingLevel | undefined;
		await this.#session.setModel(target, "default", { thinkingLevel, persist: true });
		return {
			selected: {
				provider: selection.provider,
				model: selection.model,
				...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}),
			},
		};
	}

	async settingsOverview(): Promise<{ writable: boolean; hasDocument: boolean }> {
		// The sections write through ompSettings/update; the document surface
		// stays open alongside them.
		return { writable: true, hasDocument: true };
	}

	async ompSettingsCatalog(): Promise<WebOmpSettingsCatalog> {
		const models = this.#session.getAvailableModels();
		const roles = getKnownRoleIds(this.#session.settings).map(role => {
			const raw = this.#session.settings.getModelRole(role);
			// Role values may carry an explicit thinking selector ("provider/id:max").
			const colon = raw !== undefined ? raw.lastIndexOf(":") : -1;
			const hasSuffix =
				colon > 0 &&
				raw!.slice(colon + 1) !== "" &&
				THINKING_EFFORTS.includes(raw!.slice(colon + 1) as (typeof THINKING_EFFORTS)[number]);
			return {
				id: role,
				name: MODEL_ROLES[role as keyof typeof MODEL_ROLES]?.name ?? role,
				tag: MODEL_ROLES[role as keyof typeof MODEL_ROLES]?.tag,
				model: raw !== undefined ? (hasSuffix ? raw.slice(0, colon) : raw) : undefined,
				thinking: raw !== undefined && hasSuffix ? raw.slice(colon + 1) : undefined,
			};
		});
		// Provider accounts: the OAuth registry plus every provider holding
		// credentials (some serve API keys, not OAuth).
		const auth = this.#session.modelRegistry.authStorage;
		const stored = auth.getAll();
		const byId = new Map<string, { id: string; name: string; connected: boolean; credentialCount: number }>();
		for (const oauth of getOAuthProviders()) {
			byId.set(oauth.id, {
				id: oauth.id,
				name: oauth.name,
				connected: auth.has(oauth.id),
				credentialCount: 0,
			});
		}
		for (const [provider, entry] of Object.entries(stored)) {
			const count = Array.isArray(entry) ? entry.length : 1;
			const existing = byId.get(provider);
			if (existing !== undefined) {
				existing.connected = true;
				existing.credentialCount = count;
			} else {
				byId.set(provider, { id: provider, name: provider, connected: true, credentialCount: count });
			}
		}
		return ompSettingsCatalog(this.#session.settings, models, roles, [...byId.values()]);
	}

	async setOmpSetting(key: string, value: unknown): Promise<void> {
		const handle = lookup(key);
		if (handle === undefined) throw new Error(`omp-web: unknown setting "${key}"`);
		handle.set(this.#session.settings, value);
	}

	async logoutProvider(provider: string): Promise<void> {
		await this.#session.modelRegistry.authStorage.remove(provider);
	}

	async setModelRole(role: string, selection?: { model: string; thinking?: string }): Promise<void> {
		// Role assignments route through the model manager so resolution,
		// thinking selectors, and persistence stay consistent (TUI /model).
		if (selection === undefined) {
			this.#session.settings.setModelRole(role, undefined);
			return;
		}
		const separator = selection.model.indexOf("/");
		const target = this.#session
			.getAvailableModels()
			.find(
				model =>
					model.provider === selection.model.slice(0, separator) &&
					model.id === selection.model.slice(separator + 1),
			);
		if (target === undefined) {
			throw new Error(`omp-web: model ${selection.model} is not available`);
		}
		await this.#session.setModel(target, role, {
			persist: true,
			...(selection.thinking !== undefined ? { thinkingLevel: selection.thinking as ThinkingLevel } : {}),
		});
	}

	async listFileReferences(
		sessionId: string,
		query: string,
	): Promise<Array<{ path: string; kind: "file" | "directory" }>> {
		await this.#ensureAttached(sessionId);
		const cwd = this.#session.sessionManager.getCwd();
		const prefix = query.replace(/^\/+/, "").replace(/\/+$/, "");
		// The completion token addresses a directory (list its children) or a
		// partial name (filter the parent directory's entries by that prefix).
		const segments = prefix === "" ? [] : prefix.split("/");
		const leaf = segments.pop() ?? "";
		const dir = path.resolve(cwd, ...segments);
		// `..` or absolute segments resolve outside the workspace — refuse to
		// list anything beyond the session cwd.
		if (dir !== cwd && !dir.startsWith(cwd + path.sep)) return [];
		const out: Array<{ path: string; kind: "file" | "directory" }> = [];
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return out;
		}
		const IGNORED: Record<string, true> = {
			".git": true,
			node_modules: true,
			".jj": true,
			".hg": true,
			".svn": true,
		};
		for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name.startsWith(".")) continue;
			if (leaf !== "" && !entry.name.toLowerCase().startsWith(leaf.toLowerCase())) continue;
			if (entry.isDirectory() && IGNORED[entry.name] === true) continue;
			const relative = segments.length > 0 ? `${segments.join("/")}/${entry.name}` : entry.name;
			out.push({ path: relative, kind: entry.isDirectory() ? "directory" : "file" });
			if (out.length >= 50) break;
		}
		return out;
	}

	async listSubagents(parentSessionId: string): Promise<{
		entries: Array<{
			id: string;
			mode: "one-shot" | "continuable";
			activity: "running" | "inactive";
			hasChildren: boolean;
			label?: string;
		}>;
		parentAvailable: boolean;
	}> {
		const registry = AgentRegistry.global();
		const refs = registry.list();
		const mainId = refs.find(ref => ref.kind === "main")?.id;
		const entries: Array<{
			id: string;
			mode: "one-shot" | "continuable";
			activity: "running" | "inactive";
			hasChildren: boolean;
			label?: string;
		}> = [];
		for (const ref of refs) {
			if (ref.kind !== "sub" || ref.parentId !== mainId) continue;
			// Parked children keep their sessionFile; the entry id is the child
			// session id (`<fileSafeTimestamp>_<sessionId>.jsonl` basename tail).
			const id = ref.session?.sessionId ?? this.#sessionIdFromFile(ref.sessionFile ?? undefined) ?? undefined;
			if (id === undefined) continue;
			entries.push({
				id,
				mode: "continuable",
				activity: ref.status === "running" ? "running" : "inactive",
				hasChildren: refs.some(other => other.kind === "sub" && other.parentId === ref.id),
				label: ref.displayName,
			});
		}
		return { entries, parentAvailable: parentSessionId === this.#session.sessionId };
	}

	/** Parse the session id out of one session-file basename tail. */
	#sessionIdFromFile(file: string | undefined): string | undefined {
		if (file === undefined) return undefined;
		const base = path.basename(file);
		if (!base.endsWith(".jsonl")) return undefined;
		const stem = base.slice(0, -".jsonl".length);
		const separator = stem.indexOf("_");
		return separator === -1 ? undefined : stem.slice(separator + 1);
	}

	/** Resolve one child session's live registry ref (any status). */
	#childRefOf(childSessionId: string): import("../../registry/agent-registry").AgentRef | undefined {
		return AgentRegistry.global()
			.list()
			.find(
				ref =>
					ref.kind === "sub" &&
					(ref.session?.sessionId === childSessionId ||
						this.#sessionIdFromFile(ref.sessionFile ?? undefined) === childSessionId),
			);
	}

	/** Resolve one child session's persisted info, verifying parent linkage. */
	async #childInfoOf(parentSessionId: string, childSessionId: string): Promise<SessionInfo> {
		const infos = await this.#allSessionInfos();
		const info = infos.find(candidate => candidate.id === childSessionId);
		if (info === undefined) throw new Error(`omp-web: no persisted session ${childSessionId}`);
		const parentId = this.#sessionIdFromFile(info.parentSessionPath);
		// Registry children are authorized through their ref; persisted linkage
		// covers one-shot (already-finished) children.
		const ref = this.#childRefOf(childSessionId);
		if (ref === undefined && parentId !== parentSessionId) {
			throw new Error(`omp-web: session ${childSessionId} is not a child of ${parentSessionId}`);
		}
		return info;
	}

	async subagentHistory(
		parentSessionId: string,
		childSessionId: string,
		options: WebHistoryOptions,
	): Promise<WebHistoryResult> {
		// Live children serve their canonical state; persisted children read the file.
		const ref = this.#childRefOf(childSessionId);
		let entries: ReadonlyArray<FileEntry>;
		if (ref?.session !== null && ref?.session !== undefined) {
			entries = ref.session.sessionManager.getBranch();
		} else {
			const info = await this.#childInfoOf(parentSessionId, childSessionId);
			entries = (await loadSessionFile(info.path, new FileSessionStorage())).entries;
		}
		const events = new SessionEventTranslator().translateItems(historyItemsOf(entries));
		return { ...pageHistory(events, options), imageLimits: this.#imageLimits() };
	}

	async promptSubagent(
		_parentSessionId: string,
		childSessionId: string,
		content: WebPromptPart[],
	): Promise<{ messageId: string }> {
		const ref = this.#childRefOf(childSessionId);
		const child = ref?.session;
		if (child === undefined || child === null) {
			throw new Error(`omp-web: child ${childSessionId} is parked or gone; resume it before prompting`);
		}
		const text = content
			.map(part => (part.type === "text" ? part.text : ""))
			.filter(part => part !== "")
			.join("\n");
		const images: ImageContent[] = content
			.filter((part): part is Extract<WebPromptPart, { type: "image" }> => part.type === "image")
			.map(part => ({ type: "image" as const, data: part.data, mimeType: part.mediaType }));
		if (text === "" && images.length === 0) throw new Error("omp-web: subagent prompt carried no content");
		await child.prompt(text, {
			streamingBehavior: "followUp",
			...(images.length > 0 ? { images } : {}),
		});
		return { messageId: crypto.randomUUID() };
	}

	async interruptSubagent(_parentSessionId: string, childSessionId: string): Promise<void> {
		const ref = this.#childRefOf(childSessionId);
		if (ref?.session === undefined || ref.session === null) {
			throw new Error(`omp-web: child ${childSessionId} is not live`);
		}
		await ref.session.abort();
	}

	/** Full-text search across persisted sessions (titles and message text). */
	async searchSessions(query: string): Promise<{
		items: Array<{ sessionId: string; snippet: string }>;
		hasMore: boolean;
	}> {
		const needle = query.toLowerCase();
		const infos = await this.#allSessionInfos();
		const items: Array<{ sessionId: string; snippet: string }> = [];
		let overflow = false;
		const matched = new Set<string>();
		for (const info of infos) {
			const title = info.title ?? "";
			const body = `${title}\n${info.firstMessage}\n${info.allMessagesText}`;
			const index = body.toLowerCase().indexOf(needle);
			if (index === -1) continue;
			if (items.length >= SESSION_SEARCH_LIMIT) {
				overflow = true;
				break;
			}
			matched.add(info.id);
			items.push({ sessionId: info.id, snippet: snippetAround(body, index, query.length) });
		}
		// Deep pass: the listing's message corpus is a 4KB prefix window, so a
		// cheap-pass miss says nothing about older or longer sessions. Scan the
		// raw session text of every unmatched file (newest first, capped size)
		// until the wire limit fills. JSONL keeps message text as JSON string
		// content — a plain substring hit is real; the snippet is cleaned of
		// JSON escapes for display.
		if (!overflow) {
			const candidates = infos
				.filter(info => !matched.has(info.id))
				.sort((a, b) => b.modified.getTime() - a.modified.getTime());
			for (const info of candidates) {
				let size = 0;
				try {
					size = (await Bun.file(info.path).stat()).size;
				} catch {
					continue;
				}
				if (size > SESSION_SEARCH_DEEP_MAX_FILE_BYTES) continue;
				const raw = await Bun.file(info.path)
					.text()
					.catch(() => undefined);
				if (raw === undefined) continue;
				const index = raw.toLowerCase().indexOf(needle);
				if (index === -1) continue;
				if (items.length >= SESSION_SEARCH_LIMIT) {
					overflow = true;
					break;
				}
				// Snippet from a cleaned window around the hit (cleaning shifts
				// offsets, so the needle is re-located inside the window; a hit
				// straddling an escape boundary falls back to the window head).
				const windowText = cleanJsonSnippet(raw.slice(Math.max(0, index - 600), index + 600));
				const windowIndex = windowText.toLowerCase().indexOf(needle);
				items.push({
					sessionId: info.id,
					snippet: snippetAround(windowText, Math.max(0, windowIndex), query.length),
				});
			}
		}
		return { items, hasMore: overflow };
	}

	/** Resolve one attachment against the session's own log (log = authorization). */
	async sessionAttachment(
		sessionId: string,
		attachmentId: string,
	): Promise<{ attachment: WebImageAttachmentRef; data: string } | undefined> {
		let entries: ReadonlyArray<FileEntry>;
		if (sessionId === this.#session.sessionId) {
			entries = this.#session.sessionManager.getEntries();
		} else {
			const infos = await this.#allSessionInfos();
			const info = infos.find(candidate => candidate.id === sessionId);
			if (info === undefined) return undefined;
			entries = (await loadSessionFile(info.path, new FileSessionStorage())).entries;
		}
		const found = collectSessionAttachments(entries).get(attachmentId);
		if (found === undefined) return undefined;
		const { data, ...attachment } = found;
		return { attachment, data };
	}

	async archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
		return { archivedSessionIds: this.#overrides.archiveSession(sessionId) };
	}

	/** Locate one workspace bucket (storage-derived set plus planned paths). */
	async #workspaceBuckets(): Promise<Map<string, { sessionIds: string[]; latest: number }>> {
		const { workspaces } = await this.listWorkspaces();
		return new Map(
			workspaces.map(workspace => [
				workspace.workspaceId,
				{ sessionIds: workspace.sessionIds, latest: workspace.updatedAt },
			]),
		);
	}

	async renameWorkspace(workspaceId: string, title: string): Promise<{ workspace: WebWorkspace }> {
		const trimmed = title.trim();
		if (trimmed === "") throw new Error("omp-web: workspace.rename requires a non-empty title");
		const buckets = await this.#workspaceBuckets();
		if (!buckets.has(workspaceId)) throw new Error(`omp-web: no workspace ${workspaceId}`);
		this.#overrides.renameWorkspace(workspaceId, trimmed);
		const { workspaces } = await this.listWorkspaces();
		const workspace = workspaces.find(candidate => candidate.workspaceId === workspaceId);
		if (workspace === undefined) throw new Error(`omp-web: no workspace ${workspaceId}`);
		return { workspace };
	}

	/**
	 * Registration removal (the vendored confirm dialog promises "the folder
	 * and session logs will be kept"): drops the title/order/planned overrides
	 * only. A cwd bucket with sessions reappears (basename title, default
	 * order) on the next list — only a planned empty workspace truly vanishes.
	 */
	async deleteWorkspace(workspaceId: string): Promise<{ deleted: true }> {
		const buckets = await this.#workspaceBuckets();
		if (!buckets.has(workspaceId)) throw new Error(`omp-web: no workspace ${workspaceId}`);
		this.#overrides.forgetWorkspace(workspaceId);
		return { deleted: true };
	}

	async insertWorkspaceBefore(workspaceId: string, beforeWorkspaceId?: string): Promise<{ workspaceIds: string[] }> {
		const buckets = await this.#workspaceBuckets();
		if (!buckets.has(workspaceId)) throw new Error(`omp-web: no workspace ${workspaceId}`);
		return {
			workspaceIds: this.#overrides.insertWorkspaceBefore(workspaceId, beforeWorkspaceId, [...buckets.keys()]),
		};
	}

	async insertSessionBefore(
		workspaceId: string,
		sessionId: string,
		beforeSessionId?: string,
	): Promise<{ workspace: WebWorkspace }> {
		const buckets = await this.#workspaceBuckets();
		const bucket = buckets.get(workspaceId);
		if (bucket === undefined) throw new Error(`omp-web: no workspace ${workspaceId}`);
		this.#overrides.insertSessionBefore(workspaceId, sessionId, beforeSessionId, bucket.sessionIds);
		const { workspaces } = await this.listWorkspaces();
		const workspace = workspaces.find(candidate => candidate.workspaceId === workspaceId);
		if (workspace === undefined) throw new Error(`omp-web: no workspace ${workspaceId}`);
		return { workspace };
	}

	async createWorkspace(workspacePath: string): Promise<{ workspace: WebWorkspace; created: boolean }> {
		const resolved = path.resolve(workspacePath);
		const stats = await readdir(resolved).catch(() => undefined);
		if (stats === undefined) throw new Error(`omp-web: no such directory: ${resolved}`);
		const buckets = await this.#workspaceBuckets();
		const existing = buckets.has(resolved);
		if (!existing) this.#overrides.planWorkspace(resolved);
		const { workspaces } = await this.listWorkspaces();
		const workspace = workspaces.find(candidate => candidate.workspaceId === resolved) ?? {
			workspaceId: resolved,
			path: resolved,
			title: resolved.split("/").filter(Boolean).at(-1) ?? resolved,
			sessionIds: [],
			updatedAt: 0,
		};
		return { workspace, created: !existing };
	}

	/** Directory listing for the picker (directories only, hidden flagged). */
	async listDirectory(target?: string): Promise<{
		path: string;
		home: string;
		crumbs: Array<{ name: string; path: string; hidden: boolean }>;
		entries: Array<{ name: string; path: string; hidden: boolean }>;
		truncated: boolean;
	}> {
		const home = os.homedir();
		const resolved = path.resolve(target ?? home);
		const dirents = await readdir(resolved, { withFileTypes: true });
		const dirs = dirents
			.filter(entry => entry.isDirectory())
			.map(entry => ({
				name: entry.name,
				path: path.join(resolved, entry.name),
				hidden: entry.name.startsWith("."),
			}))
			.sort((left, right) => Number(left.hidden) - Number(right.hidden) || left.name.localeCompare(right.name));
		const truncated = dirs.length > 500;
		const entries = dirs.slice(0, 500);
		const crumbs: Array<{ name: string; path: string; hidden: boolean }> = [];
		let cursor = resolved;
		for (;;) {
			crumbs.unshift({ name: path.basename(cursor) || cursor, path: cursor, hidden: false });
			const parent = path.dirname(cursor);
			if (parent === cursor) break;
			cursor = parent;
		}
		return { path: resolved, home, crumbs, entries, truncated };
	}

	async createDirectory(parent: string, name: string): Promise<{ path: string }> {
		const trimmed = name.trim();
		if (trimmed === "" || trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
			throw new Error("omp-web: createDirectory requires one plain directory name");
		}
		const target = path.join(path.resolve(parent), trimmed);
		await mkdir(target, { recursive: false });
		return { path: target };
	}

	/** CAS-check the caller's goal ref against the live goal. */
	#requireGoalRef(ref: { id: string; revision: number }): Goal {
		const state = this.#session.getGoalModeState();
		if (state === undefined) throw new Error("omp-web: no active goal");
		if (ref.id !== state.goal.id || ref.revision !== this.#goalRevisionOf(state.goal)) {
			throw new Error("omp-web: goal ref is stale (revision mismatch)");
		}
		return state.goal;
	}

	async goalCreate(sessionId: string, objective: string): Promise<{ ref: { id: string; revision: number } }> {
		await this.#ensureAttached(sessionId);
		const trimmed = objective.trim();
		if (trimmed === "") throw new Error("omp-web: goals/create requires a non-empty objective");
		if (this.#session.getPlanModeState()?.enabled === true) throw new Error("omp-web: exit plan mode first");
		if (this.#session.getVibeModeState()?.enabled === true) throw new Error("omp-web: exit vibe mode first");
		if (!cfgGoalEnabled.get(this.#session.settings)) throw new Error("omp-web: goal mode is disabled");
		const state = await this.#session.goalRuntime.createGoal({ objective: trimmed });
		const tools = this.#session.getEnabledToolNames();
		if (!tools.includes("goal")) await this.#session.setActiveToolsByName([...tools, "goal"]);
		await this.#session.sendGoalModeContext(this.#session.isStreaming ? { deliverAs: "steer" } : undefined);
		this.#goalSuppressNextContinuation = false;
		// createGoal's goal_updated already projected revision 1.
		return { ref: { id: state.goal.id, revision: this.#goalRevisionOf(state.goal) } };
	}

	async goalEdit(
		sessionId: string,
		ref: { id: string; revision: number },
		changes: { objective?: string; maxGoalRounds?: number },
	): Promise<WebGoalView> {
		await this.#ensureAttached(sessionId);
		const goal = this.#requireGoalRef(ref);
		if (changes.maxGoalRounds !== undefined) {
			throw new Error("omp-web: round caps are not supported; goals budget tokens (/goal budget)");
		}
		const objective = changes.objective?.trim();
		if (objective === undefined || objective === "") throw new Error("omp-web: goals/edit requires objective");
		const state = this.#session.getGoalModeState();
		if (state === undefined) throw new Error("omp-web: no active goal");
		const next: Goal = { ...goal, objective, updatedAt: Date.now() };
		this.#bumpGoalRevision(next);
		this.#session.setGoalModeState({ ...state, goal: next });
		this.#emitGoalProjection();
		return this.#goalViewOf();
	}

	async goalPause(sessionId: string, ref: { id: string; revision: number }): Promise<WebGoalView> {
		await this.#ensureAttached(sessionId);
		this.#requireGoalRef(ref);
		this.#cancelGoalContinuation();
		await this.#session.goalRuntime.pauseGoal();
		return this.#goalViewOf();
	}

	async goalResume(sessionId: string, ref: { id: string; revision: number }): Promise<WebGoalView> {
		await this.#ensureAttached(sessionId);
		this.#requireGoalRef(ref);
		await this.#session.goalRuntime.resumeGoal();
		await this.#session.sendGoalModeContext();
		this.#goalSuppressNextContinuation = false;
		this.#scheduleGoalContinuation();
		return this.#goalViewOf();
	}

	async goalComplete(sessionId: string, ref: { id: string; revision: number }): Promise<WebGoalView> {
		await this.#ensureAttached(sessionId);
		const goal = this.#requireGoalRef(ref);
		const completed: Goal = { ...goal, status: "complete", updatedAt: Date.now() };
		this.#bumpGoalRevision(completed);
		await this.#exitGoalMode("completed", completed);
		// The mode teardown cleared the session state; the returned view rides
		// the terminal snapshot (the emitted projection did the same).
		const projection = this.#goalProjectionFromState({ enabled: false, mode: "exiting", goal: completed });
		if (projection === null) throw new Error("omp-web: no active goal");
		return { ...projection, activation: "armed" };
	}

	async goalClear(
		sessionId: string,
		ref: { id: string; revision: number },
	): Promise<{ id: string; revision: number }> {
		await this.#ensureAttached(sessionId);
		const goal = this.#requireGoalRef(ref);
		this.#bumpGoalRevision(goal);
		await this.#exitGoalMode("cleared", undefined);
		return { id: goal.id, revision: this.#goalRevisionOf(goal) };
	}

	/**
	 * Leave goal mode (TUI #exitGoalMode mirror): restore the tool set, record
	 * the flip, then project the terminal state (complete keeps the snapshot;
	 * cleared/dropped clears the bar).
	 */
	async #exitGoalMode(reason: "completed" | "cleared" | "dropped", terminalGoal: Goal | undefined): Promise<void> {
		const state = this.#session.getGoalModeState();
		if (terminalGoal !== undefined && state !== undefined) {
			this.#session.setGoalModeState({ ...state, enabled: false, goal: terminalGoal });
			this.#emitGoalProjection();
		}
		this.#cancelGoalContinuation();
		this.#session.setGoalModeState(undefined);
		this.#session.sessionManager.appendModeChange("none");
		const tools = this.#session.getEnabledToolNames();
		if (tools.includes("goal")) {
			await this.#session.setActiveToolsByName(tools.filter(name => name !== "goal"));
		}
		if (reason === "completed") {
			this.#session.sessionManager.appendCustomEntry("goal-completed", {
				reason: "completed",
				at: new Date().toISOString(),
			});
		}
		if (terminalGoal === undefined) this.#emitGoalProjection();
	}

	async openSettingsDocument(): Promise<void> {
		const target = path.join(getAgentDir(), MAIN_CONFIG_FILENAMES[0]);
		const file = Bun.file(target);
		if (!(await file.exists())) {
			// Materialize an empty document so the opener has a target.
			await Bun.write(target, "# omp settings (documentation: /settings in the TUI)\n");
		}
		// `start` is a cmd builtin (not an executable), so win32 rides the shell.
		const argv =
			process.platform === "darwin"
				? ["open", target]
				: process.platform === "win32"
					? ["cmd", "/c", "start", "", target]
					: ["xdg-open", target];
		const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
		await proc.exited;
	}

	/** The browser-client settings store (one JSON document under the agent dir). */
	async #clientSettingsFile(): Promise<Record<string, Record<string, unknown>>> {
		const file = Bun.file(path.join(getAgentDir(), "web-client-settings.json"));
		if (!(await file.exists())) return {};
		try {
			const parsed = (await file.json()) as Record<string, Record<string, unknown>>;
			return typeof parsed === "object" && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	}

	async clientSettingNamespaces(): Promise<Array<{ ns: string; value: Record<string, unknown> }>> {
		const all = await this.#clientSettingsFile();
		return Object.entries(all).map(([ns, value]) => ({ ns, value }));
	}

	async mutateClientSetting(
		ns: string,
		ops: Array<{ op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] }>,
	): Promise<{ ns: string; value: Record<string, unknown> }> {
		const all = await this.#clientSettingsFile();
		const existing = all[ns];
		const section: Record<string, unknown> =
			typeof existing === "object" && existing !== null && !Array.isArray(existing)
				? (JSON.parse(JSON.stringify(existing)) as Record<string, unknown>)
				: {};
		for (const op of ops) {
			if (op.path.length === 0 || op.path.some(segment => UNSAFE_PATH_SEGMENTS[segment] === true)) {
				throw new Error(`omp-web: clientSettings/mutate refuses path ${op.path.join(".")}`);
			}
			applyNestedOp(section, op);
		}
		all[ns] = section;
		// Atomic write: temp + rename, so a crash mid-write cannot truncate the
		// only copy of the client's settings.
		const target = path.join(getAgentDir(), "web-client-settings.json");
		const tmp = `${target}.${process.pid}.tmp`;
		await Bun.write(tmp, JSON.stringify(all));
		await rename(tmp, target);
		return { ns, value: section };
	}

	async listSkills(sessionId: string): Promise<WebSkillEntry[]> {
		await this.#ensureAttached(sessionId);
		// Skills are only user-invocable when skill commands are enabled; the
		// dsh catalog lists the `/name` vocabulary, so a disabled switch lists
		// nothing rather than rows that would not run.
		if (this.#session.skillsSettings?.enableSkillCommands !== true) return [];
		return this.#session.skills.map(skill => ({
			name: getSkillSlashCommandName(skill),
			description: skill.description,
			modelInvocable: skill.hide !== true,
		}));
	}

	async exportSessionLog(
		sessionId: string,
		includeDescendants: boolean,
	): Promise<{ entries: Array<{ name: string; data: Uint8Array }> } | undefined> {
		const infos = await this.#allSessionInfos();
		const root = infos.find(candidate => candidate.id === sessionId);
		if (root === undefined) return undefined;
		// Descendants: sessions in the same bucket whose parentSession chain
		// reaches the root. The header field holds the parent ID (path form
		// exists in pre-normalization files).
		const byId = new Map(infos.map(info => [info.id, info] as const));
		const parentIdOf = (info: SessionInfo): string | undefined => {
			const raw = info.parentSessionPath;
			if (raw === undefined) return undefined;
			if (byId.has(raw)) return raw;
			const base = raw.split("/").at(-1) ?? "";
			const stem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
			return byId.has(stem) ? stem : undefined;
		};
		const included = new Map<string, SessionInfo>([[root.id, root]]);
		if (includeDescendants) {
			let grew = true;
			while (grew) {
				grew = false;
				for (const info of infos) {
					if (included.has(info.id)) continue;
					const parent = parentIdOf(info);
					if (parent !== undefined && included.has(parent)) {
						included.set(info.id, info);
						grew = true;
					}
				}
			}
		}
		if (included.has(this.#session.sessionId)) await this.#session.sessionManager.flush();
		const entries: Array<{ name: string; data: Uint8Array }> = [];
		for (const info of included.values()) {
			entries.push({ name: `${info.id}.jsonl`, data: await readFile(info.path) });
		}
		return { entries };
	}

	async listCommands(sessionId: string): Promise<WebCommandDescriptor[]> {
		await this.#ensureAttached(sessionId);
		const commands = await buildAvailableSlashCommands(this.#session);
		return (
			commands
				// Names the dsh client owns as popup contributions must not come from
				// the host (a collision makes the client's candidate fetch throw):
				// the GUI serves /model through its own selector over session.models.
				.filter(command => CLIENT_OWNED_COMMANDS[command.name] !== true)
				.map(command => ({
					name: command.name,
					description: command.description ?? "",
					// An argument-taking command must declare the input claim or the
					// client falls `/name args` through to the model as a prompt.
					...(command.input !== undefined ? { input: { hint: command.input.hint } } : {}),
				}))
				// The plan toggle is TUI-only in the builtin registry (its state machine
				// lives in the interactive mode), but the web plan bridge serves it and
				// the client's plan chip dispatches /plan off through it.
				.concat([
					{
						name: "plan",
						description: "Toggle plan mode (agent plans before executing)",
						input: { hint: "optional task to plan" },
					},
					{
						name: "vibe",
						description: "Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset)",
						input: { hint: "optional task for the workers" },
					},
					{
						name: "goal",
						description: "Toggle goal mode (persistent autonomous objective for this session)",
						input: { hint: "objective, or status/pause/resume/complete/clear/budget" },
					},
					{
						name: "guided-goal",
						description: "Start a guided goal interview (agent elicits the objective, then goal mode runs it)",
					},
					{
						name: "plan-review",
						description: "Show the session's newest plan file for review",
					},
					{
						name: "loop",
						description: "Loop the last prompt each turn (/loop [count|duration] [prompt]; /loop again to stop)",
						input: { hint: "[count|duration] [prompt]" },
					},
					{
						name: "btw",
						description: "Side question that does not enter the session context (/btw <question>)",
						input: { hint: "question" },
					},
					{
						name: "tan",
						description: "Dispatch a tangential background fork (/tan <work>)",
						input: { hint: "work description" },
					},
					{
						name: "clear",
						description: "Clear the conversation context in place, keeping the session",
					},
					{
						name: "drop",
						description: "Delete the current session and start a new one",
					},
				])
		);
	}

	async executeCommand(sessionId: string, line: string): Promise<WebCommandExecution | undefined> {
		await this.#ensureAttached(sessionId);
		if (!line.startsWith("/")) return undefined;
		const name = line.slice(1).split(/\s+/)[0];
		const known = await this.listCommands(sessionId);
		if (!known.some(command => command.name === name)) return undefined;
		const commandId = crypto.randomUUID();
		const args = line.slice(1 + name.length);
		const output: string[] = [];
		// The run/done lifecycle pair renders the command in the chat flow and
		// persists as custom entries so a reload replays it (command records
		// interleave with messages at their original positions).
		this.#emitCommandEvent(sessionId, this.#translator.appendCommandRun(commandId, name, args));
		this.#session.sessionManager.appendCustomEntry(COMMAND_ENTRY_TYPE, {
			phase: "run",
			commandId,
			name,
			args,
		});
		const settle = (kind: "success" | "error", text: string | undefined): WebCommandExecution => {
			const result = {
				kind,
				...(text !== undefined && text !== "" ? { text } : {}),
			} as WebCommandExecution["result"];
			this.#emitCommandEvent(sessionId, this.#translator.appendCommandDone(commandId, kind, text));
			this.#session.sessionManager.appendCustomEntry(COMMAND_ENTRY_TYPE, {
				phase: "done",
				commandId,
				kind,
				text,
			});
			return { commandId, result };
		};
		try {
			// The RPC dispatch chain, in order: the plan bridge drives the plan-mode
			// state machine; skill commands build their own prompt message; text-mode
			// builtins run locally (some resolve to a residual prompt); everything
			// else rides the prompt path (extension commands, prompt templates).
			// Prompt legs stream as ordinary turns after the done event — the RPC
			// answers admission, not completion.
			if (name === "plan") {
				const outcome = await this.#executePlanCommand(args);
				return settle(outcome.ok ? "success" : "error", outcome.text);
			}
			if (name === "vibe") {
				const outcome = await this.#executeVibeCommand(args);
				return settle(outcome.ok ? "success" : "error", outcome.text);
			}
			if (name === "goal") {
				const outcome = await this.#executeGoalCommand(args);
				return settle(outcome.ok ? "success" : "error", outcome.text);
			}
			if (name === "guided-goal") {
				const outcome = await this.#executeGuidedGoalCommand(args);
				return settle(outcome.ok ? "success" : "error", outcome.text);
			}
			if (name === "plan-review") {
				const outcome = await this.#executePlanReviewCommand();
				return settle(outcome.ok ? "success" : "error", outcome.text);
			}
			if (name === "loop") {
				const outcome = this.#executeLoopCommand(args);
				return settle(outcome.ok ? "success" : "error", outcome.text);
			}
			if (name === "btw") {
				const outcome = await this.#executeBtwCommand(args);
				return settle(outcome.ok ? "success" : "error", outcome.text);
			}
			if (name === "tan") {
				const outcome = await this.#executeTanCommand(args);
				return settle(outcome.ok ? "success" : "error", outcome.text);
			}
			if (name === "clear") {
				const outcome = await this.#executeClearCommand();
				return settle(outcome.ok ? "success" : "error", outcome.text);
			}
			if (name === "drop") {
				const outcome = await this.#executeDropCommand(sessionId);
				// The window moved to a fresh session: the run/done pair for /drop
				// was emitted against the OLD session id (its log is deleted);
				// settle on the new session's stream instead.
				return settle(outcome.ok ? "success" : "error", outcome.text);
			}
			const skill = await tryRunRpcSkillCommand(this.#session, line);
			if (skill !== false) {
				return settle("success", undefined);
			}
			const builtin = await executeAcpBuiltinSlashCommand(line, {
				session: this.#session,
				sessionManager: this.#session.sessionManager,
				settings: this.#session.settings,
				cwd: this.#session.sessionManager.getCwd(),
				output: text => {
					output.push(text);
				},
				refreshCommands: async () => {
					this.#emit({ kind: "commands-changed" });
				},
				reloadPlugins: async () => {
					// Mirror the RPC mode's reload: clear discovery caches, rebuild
					// capabilities/skills/slash commands, then broadcast the change.
					const cwd = this.#session.sessionManager.getCwd();
					const projectPath = await resolveActiveProjectRegistryPath(cwd);
					clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
					resetCapabilities();
					await this.#session.refreshSkills();
					this.#session.setSlashCommands(await loadSlashCommands({ cwd }));
					this.#emit({ kind: "commands-changed" });
				},
				notifyTitleChanged: async () => {
					const title = this.#session.sessionName;
					if (title === undefined || title === "") return;
					const seq = this.#translator.nextSeq();
					this.#emit({ kind: "session-projection", sessionId, key: "title", value: title, seq });
				},
				notifyConfigChanged: async () => {
					// No models-changed frame exists in the stream vocabulary; the
					// client re-pulls session.models when its selector opens.
				},
			});
			if (builtin !== false) {
				if ("prompt" in builtin) {
					void this.#session.prompt(builtin.prompt).catch(error => {
						logger.warn(
							`omp-web: command prompt failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					});
				}
				return settle("success", output.length > 0 ? stripAnsi(output.join("\n")) : undefined);
			}
			void this.#session.prompt(line).catch(error => {
				logger.warn(`omp-web: command prompt failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			return settle("success", undefined);
		} catch (error) {
			return settle("error", error instanceof Error ? error.message : String(error));
		}
	}

	/** Push one synthetic command lifecycle event onto the mux downlink. */
	#emitCommandEvent(sessionId: string, event: WebSessionEvent): void {
		this.#emit({ kind: "session-event", sessionId, event });
	}

	/**
	 * The plan-mode state machine (the interactive mode's enter/exit core):
	 * flip the session state, widen the tool set with the built-in write for
	 * plan drafting/approval, deliver the mode context, then mirror the flip
	 * as a plan/mode event + projection so the client's plan chip tracks it.
	 */
	async #executePlanCommand(args: string): Promise<{ ok: boolean; text: string }> {
		const state = this.#session.getPlanModeState();
		const trimmed = args.trim();
		const wants = trimmed === "off" ? false : trimmed === "on" ? true : !state?.enabled;
		const sessionId = this.#session.sessionId;
		if (wants) {
			if (!cfgPlanEnabled.get(this.#session.settings)) {
				return { ok: false, text: "Plan mode is disabled (plan.enabled in settings)." };
			}
			if (this.#session.getGoalModeState()?.enabled) {
				return { ok: false, text: "Exit goal mode first." };
			}
			const previous = this.#session.getEnabledToolNames();
			const planTools = this.#session.hasBuiltInTool("write") ? [...new Set([...previous, "write"])] : previous;
			this.#planModePreviousTools = previous;
			const planFilePath = this.#session.getPlanReferencePath() || "local://PLAN.md";
			this.#session.setPlanModeState({ enabled: true, planFilePath, workflow: "parallel", reentry: false });
			this.#session.sessionManager.appendModeChange("plan", { planFilePath });
			await this.#session.setActiveToolsByName(planTools);
			await this.#session.sendPlanModeContext();
			this.#emitPlanFlip(sessionId, true);
			// TUI parity: `/plan <prompt>` enters plan mode and submits the prompt
			// (steering into an in-flight turn).
			const initialPrompt = trimmed === "on" ? "" : trimmed;
			if (initialPrompt !== "") {
				void this.#session
					.prompt(initialPrompt, {
						streamingBehavior: this.#session.isStreaming ? ("steer" as const) : ("followUp" as const),
					})
					.catch(error => {
						logger.warn(`omp-web: plan prompt failed: ${error instanceof Error ? error.message : String(error)}`);
					});
			}
			return { ok: true, text: "Plan mode on. Use /plan off to leave." };
		}
		if (!state?.enabled) {
			return { ok: true, text: "Plan mode off." };
		}
		this.#session.setPlanModeState(undefined);
		this.#session.sessionManager.appendModeChange("none");
		await this.#session.setActiveToolsByName(this.#planModePreviousTools ?? this.#session.getEnabledToolNames());
		this.#planModePreviousTools = undefined;
		await this.#session.sendPlanModeContext();
		this.#emitPlanFlip(sessionId, false);
		return { ok: true, text: "Plan mode off." };
	}

	/** Mirror one plan flip as the plan/mode event plus the plan projection. */
	#emitPlanFlip(sessionId: string, active: boolean): void {
		this.#emitCommandEvent(sessionId, this.#translator.appendPlanMode(active));
		const seq = this.#translator.nextSeq();
		this.#emit({ kind: "session-projection", sessionId, key: "plan", value: { active, pending: false }, seq });
	}

	/** The CAS revision of one goal (0 for a goal first seen now). */
	#goalRevisionOf(goal: Goal): number {
		return this.#goalRevisions.get(goal.id) ?? 0;
	}

	/** Bump and return the CAS revision after a durable goal mutation. */
	#bumpGoalRevision(goal: Goal): number {
		const next = this.#goalRevisionOf(goal) + 1;
		this.#goalRevisions.set(goal.id, next);
		return next;
	}

	/** Fold one goal-mode state onto the wire projection (null = cleared). */
	#goalProjectionFromState(state: GoalModeState | undefined): WebGoalProjection | null {
		if (state === undefined) return null;
		const goal = state.goal;
		if (goal.status === "dropped") return null;
		const phase =
			goal.status === "active"
				? ("active" as const)
				: goal.status === "paused"
					? ("paused" as const)
					: goal.status === "complete"
						? ("complete" as const)
						: ("blocked" as const);
		return {
			goal: {
				id: goal.id,
				revision: this.#goalRevisionOf(goal),
				objective: goal.objective,
				phase,
				...(phase === "blocked"
					? { blockedReason: { code: "budget-limited", message: "token budget reached" } }
					: {}),
				// omp goals budget tokens, not rounds; 0 documents "no round cap".
				maxGoalRounds: 0,
			},
			roundsStarted: 0,
			createdAt: goal.createdAt,
			updatedAt: goal.updatedAt,
		};
	}

	/** Fold the session's live goal state onto the wire projection. */
	#goalProjection(): WebGoalProjection | null {
		return this.#goalProjectionFromState(this.#session.getGoalModeState());
	}

	/** Emit the goal projection frame (the ui-goal goal bar's data). */
	#emitGoalProjection(state?: GoalModeState): void {
		this.#emit({
			kind: "session-projection",
			sessionId: this.#session.sessionId,
			key: "goal",
			value: state !== undefined ? this.#goalProjectionFromState(state) : this.#goalProjection(),
			seq: this.#translator.nextSeq(),
		});
	}

	/** The settled goal view for the goals/* RPCs (CAS-checked callers). */
	#goalViewOf(): WebGoalView {
		const projection = this.#goalProjection();
		if (projection === null) throw new Error("omp-web: no active goal");
		return { ...projection, activation: "armed" };
	}

	/** Deployment image-intake limits (the imageLimits projection constant). */
	#imageLimits(): WebImageLimits {
		return {
			maxImageBytes: 10 * 1024 * 1024,
			maxImagesPerMessage: 10,
			maxMessageImageBytes: 30 * 1024 * 1024,
			maxImagePixels: 8192 * 8192,
			maxImageDimension: 8192,
			mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
		};
	}

	/** The vibe parent facade the registry scopes workers against (TUI mirror). */
	#vibeParentSession(): VibeParentSession {
		return {
			getAgentId: () => this.#session.getAgentId() ?? null,
			getSessionId: () => this.#session.sessionManager.getSessionId(),
			getSessionFile: () => this.#session.sessionManager.getSessionFile() ?? null,
			sessionManager: this.#session.sessionManager,
			asyncJobManager: this.#session.asyncJobManager,
			settings: this.#session.settings,
			getActiveModelString: () =>
				this.#session.model !== undefined ? formatModelString(this.#session.model) : undefined,
		};
	}

	/**
	 * The vibe-mode state machine (the interactive mode's enter/exit core):
	 * toggle the read-only toolset, flip the session state, deliver the mode
	 * context, and persist the flip as a mode_change entry. Exit also tears
	 * down the live worker sessions — the previous web bridge skipped that,
	 * leaking vibe workers past the mode.
	 */
	async #executeVibeCommand(args: string): Promise<{ ok: boolean; text: string }> {
		if (this.#session.getVibeModeState()?.enabled === true) {
			const registry = VibeSessionRegistry.global();
			const parent = this.#vibeParentSession();
			const ownerScope = registry.ownerScope(parent);
			await this.#session.runModeExitTeardown(async () => {
				if (this.#session.isStreaming) await this.#session.abort();
				// TUI parity: leaving vibe mode kills its worker sessions.
				await registry.killAll(parent, ownerScope);
				await this.#session.deactivateVibeTools(this.#vibePreviousTools ?? this.#session.getEnabledToolNames());
				this.#session.setVibeModeState(undefined);
			});
			this.#vibePreviousTools = undefined;
			this.#session.sessionManager.appendModeChange("none");
			return { ok: true, text: "Vibe mode disabled." };
		}
		if (this.#session.getPlanModeState()?.enabled === true) return { ok: false, text: "Exit plan mode first." };
		if (this.#session.getGoalModeState()?.enabled === true) return { ok: false, text: "Exit goal mode first." };
		this.#vibePreviousTools = this.#session.getEnabledToolNames();
		const baseTools = this.#session.hasBuiltInTool("todo") ? ["read", "todo"] : ["read"];
		await this.#session.activateVibeTools(baseTools);
		this.#session.setVibeModeState({ enabled: true });
		this.#session.sessionManager.appendModeChange("vibe");
		await this.#session.sendVibeModeContext(this.#session.isStreaming ? { deliverAs: "steer" } : undefined);
		// TUI parity: `/vibe <prompt>` enters vibe mode and submits the prompt.
		const initialPrompt = args.trim();
		if (initialPrompt !== "") {
			void this.#session
				.prompt(initialPrompt, {
					streamingBehavior: this.#session.isStreaming ? ("steer" as const) : ("followUp" as const),
				})
				.catch(error => {
					logger.warn(`omp-web: vibe prompt failed: ${error instanceof Error ? error.message : String(error)}`);
				});
		}
		return { ok: true, text: "Vibe mode on (read-only workers; /vibe again to leave)." };
	}

	/**
	 * The goal-mode command bridge (TUI handleGoalModeCommand parity): the
	 * subcommands ride the goal runtime (which persists mode_change and emits
	 * goal_updated — the projection follows the event), and the bare
	 * `/goal <objective>` shorthand starts a goal and submits the objective as
	 * the opening user prompt.
	 */
	async #executeGoalCommand(args: string): Promise<{ ok: boolean; text: string }> {
		const trimmed = args.trim();
		const [head = "", ...rest] = trimmed.split(/\s+/);
		const subRest = rest.join(" ").trim();
		const state = this.#session.getGoalModeState();
		const hasGoal = state !== undefined && state.goal.status !== "dropped";
		switch (head) {
			case "set": {
				if (subRest === "") return { ok: false, text: "Usage: /goal set <objective>" };
				return await this.#startGoal(subRest);
			}
			case "show": {
				if (!hasGoal || state === undefined) return { ok: true, text: "No goal is set." };
				const goal = state.goal;
				return {
					ok: true,
					text: `Goal: ${goal.objective}\nStatus: ${goal.status}${state.enabled ? "" : " (paused)"}\nTokens used: ${goal.tokensUsed}${goal.tokenBudget !== undefined ? ` / ${goal.tokenBudget}` : ""}`,
				};
			}
			case "pause": {
				if (!hasGoal || state === undefined || !state.enabled) {
					return { ok: false, text: "No active goal to pause." };
				}
				this.#cancelGoalContinuation();
				await this.#session.goalRuntime.pauseGoal();
				return { ok: true, text: "Goal paused. Use /goal resume to continue." };
			}
			case "resume": {
				if (!hasGoal || state === undefined) return { ok: false, text: "No goal to resume." };
				if (state.enabled) return { ok: true, text: "Goal is already active." };
				await this.#session.goalRuntime.resumeGoal();
				await this.#session.sendGoalModeContext();
				this.#goalSuppressNextContinuation = false;
				this.#scheduleGoalContinuation();
				return { ok: true, text: `Goal resumed: ${state.goal.objective}` };
			}
			case "drop": {
				if (!hasGoal) return { ok: false, text: "No goal to drop." };
				const goal = this.#session.getGoalModeState()?.goal;
				if (goal !== undefined) this.#bumpGoalRevision(goal);
				await this.#session.goalRuntime.dropGoal();
				await this.#exitGoalMode("dropped", undefined);
				return { ok: true, text: "Goal dropped." };
			}
			case "budget": {
				if (!hasGoal || state === undefined || !state.enabled) {
					return {
						ok: false,
						text: state !== undefined ? "Resume the goal before adjusting the budget." : "No active goal.",
					};
				}
				if (state.goal.status === "complete") return { ok: true, text: "Goal is already complete." };
				const budgetArg = subRest.toLowerCase();
				let nextBudget: number | undefined;
				if (budgetArg !== "off") {
					const parsed = Number.parseInt(budgetArg, 10);
					if (!Number.isInteger(parsed) || parsed <= 0) {
						return { ok: false, text: "Goal budget must be a positive integer or `off`." };
					}
					nextBudget = parsed;
				}
				await this.#session.goalRuntime.onBudgetMutated(nextBudget);
				this.#goalSuppressNextContinuation = false;
				this.#scheduleGoalContinuation();
				return {
					ok: true,
					text: nextBudget === undefined ? "Goal budget cleared." : `Goal budget set to ${nextBudget}.`,
				};
			}
			default: {
				// Bare-objective shorthand: `/goal <objective>` starts the goal and
				// submits the objective as the opening prompt (TUI #startGoalFromObjective).
				if (hasGoal) {
					return {
						ok: false,
						text: "Goal mode is already active. Use /goal show|pause|resume|budget|drop to manage it.",
					};
				}
				if (trimmed === "") {
					return {
						ok: false,
						text: "Usage: /goal <objective> | /goal <set|show|pause|resume|drop|budget> [args]",
					};
				}
				return await this.#startGoal(trimmed);
			}
		}
	}

	/** Start a goal from one objective and submit it as the opening prompt. */
	async #startGoal(objective: string): Promise<{ ok: boolean; text: string }> {
		if (this.#session.getPlanModeState()?.enabled === true) return { ok: false, text: "Exit plan mode first." };
		if (this.#session.getVibeModeState()?.enabled === true) return { ok: false, text: "Exit vibe mode first." };
		if (!cfgGoalEnabled.get(this.#session.settings)) {
			return { ok: false, text: "Goal mode is disabled. Enable it in settings (goal.enabled)." };
		}
		try {
			await this.#session.goalRuntime.createGoal({ objective });
		} catch (error) {
			return { ok: false, text: error instanceof Error ? error.message : String(error) };
		}
		const tools = this.#session.getEnabledToolNames();
		if (!tools.includes("goal")) await this.#session.setActiveToolsByName([...tools, "goal"]);
		await this.#session.sendGoalModeContext(this.#session.isStreaming ? { deliverAs: "steer" } : undefined);
		this.#goalSuppressNextContinuation = false;
		// The objective is the opening prompt (the TUI routes it through the
		// input loop; the web bridge prompts directly).
		void this.#session
			.prompt(objective, {
				streamingBehavior: this.#session.isStreaming ? ("steer" as const) : ("followUp" as const),
			})
			.catch(error => {
				logger.warn(`omp-web: goal prompt failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		return { ok: true, text: `Goal set: ${objective}` };
	}

	/**
	 * The guided-goal interview kickoff (TUI handleGuidedGoalCommand parity):
	 * expose the goal tool so the interview can finish with `goal create`,
	 * then send the hidden interview prompt as a synthetic turn.
	 */
	async #executeGuidedGoalCommand(args: string): Promise<{ ok: boolean; text: string }> {
		if (this.#session.getPlanModeState()?.enabled === true) return { ok: false, text: "Exit plan mode first." };
		if (this.#session.getVibeModeState()?.enabled === true) return { ok: false, text: "Exit vibe mode first." };
		if (!cfgGoalEnabled.get(this.#session.settings)) {
			return { ok: false, text: "Goal mode is disabled. Enable it in settings (goal.enabled)." };
		}
		const existing = this.#session.getGoalModeState();
		if (existing !== undefined && existing.goal.status !== "dropped") {
			return { ok: false, text: "Goal mode is already active. Use /goal drop to start over." };
		}
		const tools = this.#session.getEnabledToolNames();
		if (!tools.includes("goal")) await this.#session.setActiveToolsByName([...tools, "goal"]);
		const kickoff = promptTemplate.render(guidedGoalInterviewPrompt, { initial: args.trim() || undefined });
		if (this.#session.isStreaming) {
			await this.#session.followUp(kickoff, undefined, { synthetic: true });
		} else {
			void this.#session.prompt(kickoff, { synthetic: true }).catch(async error => {
				// A turn raced the dispatch: queue behind it instead of failing.
				if (this.#session.isStreaming) {
					await this.#session.followUp(kickoff, undefined, { synthetic: true }).catch(() => {});
					return;
				}
				logger.warn(
					`omp-web: guided-goal kickoff failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		}
		return { ok: true, text: "Guided goal interview started. Answer the agent's questions; it will set the goal." };
	}

	/** The /loop toggle (TUI loop mode): arm, restate, or disable. */
	#executeLoopCommand(args: string): { ok: boolean; text: string } {
		if (this.#loopEnabled) {
			this.#disableLoop("Loop mode disabled.");
			return { ok: true, text: "Loop mode disabled." };
		}
		const parsed = parseLoopArgs(args);
		if (typeof parsed === "string") return { ok: false, text: parsed };
		const loopMode = cfgLoopMode.get(this.#session.settings);
		if (loopMode !== "prompt") {
			return {
				ok: false,
				text: `loop.mode is "${loopMode}"; the web host supports the prompt repeat mode only.`,
			};
		}
		this.#loopEnabled = true;
		this.#loopLimit = parsed.limit !== undefined ? createLoopLimitRuntime(parsed.limit) : undefined;
		const inlinePrompt = parsed.prompt?.trim();
		if (inlinePrompt !== undefined && inlinePrompt !== "") {
			this.#loopPrompt = inlinePrompt;
			void this.#session.prompt(inlinePrompt, { streamingBehavior: "followUp" }).catch(error => {
				logger.warn(`omp-web: loop prompt failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			return {
				ok: true,
				text: `Loop mode on${this.#loopLimit !== undefined ? ` (${describeLoopLimitRuntime(this.#loopLimit)})` : ""}: repeating "${inlinePrompt.slice(0, 60)}" each turn.`,
			};
		}
		this.#loopPrompt = undefined;
		return {
			ok: true,
			text: `Loop mode on${this.#loopLimit !== undefined ? ` (${describeLoopLimitRuntime(this.#loopLimit)})` : ""}. The next prompt you send repeats each turn; /loop again to stop.`,
		};
	}

	/** The /btw side question (TUI parity): an ephemeral turn off the record. */
	async #executeBtwCommand(args: string): Promise<{ ok: boolean; text: string }> {
		const question = args.trim();
		if (question === "") return { ok: false, text: "Usage: /btw <question>" };
		try {
			const result = await this.#session.runEphemeralTurn({ promptText: question });
			return { ok: true, text: result.replyText !== "" ? result.replyText : "(no reply)" };
		} catch (error) {
			return { ok: false, text: error instanceof Error ? error.message : String(error) };
		}
	}

	/**
	 * The /tan background fork (the TUI TanCommandController ported onto the
	 * web driver's session): clone the transcript into a nested artifact
	 * session, run the work in a background job, and leave a dispatch
	 * breadcrumb for the parent context.
	 */
	async #executeTanCommand(args: string): Promise<{ ok: boolean; text: string }> {
		const trimmedWork = args.trim();
		if (trimmedWork === "") return { ok: false, text: "Usage: /tan <work>" };
		const session = this.#session;
		const model = session.model;
		if (!model) return { ok: false, text: "No active model available for /tan." };
		const manager = session.asyncJobManager;
		if (!manager) return { ok: false, text: "Background jobs are disabled; enable async jobs to use /tan." };
		const parentFile = session.sessionManager.getSessionFile();
		if (!parentFile) return { ok: false, text: "/tan requires a persisted session." };
		const parentSessionId = session.sessionId;
		const parentPromptCacheKey = session.agent.promptCacheKey ?? parentSessionId;
		const thinkingLevel = session.configuredThinkingLevel();
		const systemPrompt = [...session.systemPrompt];
		const toolNames = session.getEnabledToolNames();
		const modelRegistry = session.modelRegistry;
		const ownerId = session.getAgentId() ?? MAIN_AGENT_ID;
		const cwd = session.sessionManager.getCwd();
		const parentArtifactsDir = session.sessionManager.getArtifactsDir();
		const parentLocalSessionId = session.sessionManager.getSessionId();
		const localProtocolOptions = {
			getArtifactsDir: () => parentArtifactsDir,
			getSessionId: () => parentLocalSessionId,
		};
		const sessionDir = parentFile.slice(0, -6);
		const settings = createSubagentSettings(session.settings);
		const enableLsp = cfgTaskEnableLsp.get(session.settings) !== false;
		const agentRegistry = AgentRegistry.global();
		const cloneId = `Tan-${Snowflake.next()}`;
		const cloneFile = path.join(sessionDir, `${cloneId}.jsonl`);
		const label = `/tan ${trimmedWork.trim().replace(/\s+/g, " ").slice(0, 80)}`;

		await session.sessionManager.ensureOnDisk();
		await session.sessionManager.flush();

		let jobId = "";
		try {
			const cloneManager = await SessionManager.forkFrom(parentFile, cwd, sessionDir, undefined, {
				copyArtifacts: false,
				suppressBreadcrumb: true,
				sessionFile: cloneFile,
			});
			jobId = manager.register(
				"task",
				label,
				async ({ signal }) => {
					if (signal.aborted) throw new Error("Aborted before execution");
					let clone: AgentSession | undefined;
					try {
						const created = await sdk.createAgentSession({
							cwd,
							sessionManager: cloneManager,
							model,
							thinkingLevel,
							systemPrompt,
							toolNames,
							providerSessionId: `${parentSessionId}:tan:${Snowflake.next()}`,
							providerPromptCacheKey: parentPromptCacheKey,
							modelRegistry,
							authStorage: modelRegistry.authStorage,
							settings,
							hasUI: false,
							enableMCP: false,
							enableLsp,
							agentId: cloneId,
							agentDisplayName: "tan",
							parentTaskPrefix: cloneId,
							parentAgentId: ownerId,
							agentRegistry,
							disableExtensionDiscovery: true,
							localProtocolOptions,
						});
						clone = created.session;
						clone.sessionManager?.appendSessionInit?.({
							systemPrompt: clone.systemPrompt ? clone.systemPrompt.join("\n\n") : systemPrompt.join("\n\n"),
							task: trimmedWork,
							tools: clone.getEnabledToolNames(),
						});
						const abortClone = () => {
							void clone?.abort();
						};
						signal.addEventListener("abort", abortClone, { once: true });
						// The fork inherits the parent's todo list via session entries;
						// its reminders would drag the tan back onto the parent's task.
						clone.setTodoPhases([]);
						cloneManager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: [] });
						const injectContextSwitch = () => {
							clone?.agent.appendMessage({
								role: "developer",
								content: tanContextSwitchPrompt,
								attribution: "agent",
								timestamp: Date.now(),
							});
						};
						// Compaction summarizes the fork notice away; re-inject after
						// every successful compaction so the boundary survives.
						const unsubscribeCompaction = clone.subscribe(event => {
							if (event.type === "auto_compaction_end" && event.result && !event.aborted) {
								injectContextSwitch();
							}
						});
						try {
							if (signal.aborted) {
								abortClone();
								throw new Error("Aborted before execution");
							}
							injectContextSwitch();
							await clone.prompt(trimmedWork, { attribution: "user" });
							await clone.waitForIdle();
							const last = clone.getLastAssistantMessage();
							const text = last?.content
								.filter(block => block.type === "text")
								.map(block => block.text)
								.join("")
								.trim();
							return text !== undefined && text !== "" ? text : "(no output)";
						} finally {
							unsubscribeCompaction();
							signal.removeEventListener("abort", abortClone);
						}
					} finally {
						if (clone) {
							if (signal.aborted) {
								agentRegistry.setStatus(cloneId, "aborted");
								await clone.dispose();
							} else {
								agentRegistry.setStatus(cloneId, "parked");
								await clone.dispose();
								agentRegistry.detachSession(cloneId);
							}
						}
					}
				},
				{ ownerId, agentId: cloneId },
			);
		} catch (error) {
			await Promise.allSettled([
				rm(cloneFile, { force: true }),
				rm(cloneFile.slice(0, -6), { recursive: true, force: true }),
			]);
			return { ok: false, text: error instanceof Error ? error.message : String(error) };
		}

		const content = promptTemplate.render(backgroundTanDispatchPrompt, { jobId, work: trimmedWork });
		await session.sendCustomMessage(
			{
				customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
				content,
				display: true,
				attribution: "user",
				details: { jobId, work: trimmedWork, sessionFile: cloneFile },
			},
			{ triggerTurn: false, deliverAs: "nextTurn" },
		);
		return { ok: true, text: `Dispatched background tan ${jobId}` };
	}

	/** The /clear bridge (TUI handleResetContextCommand parity). */
	async #executeClearCommand(): Promise<{ ok: boolean; text: string }> {
		if (this.#session.isStreaming || this.#session.isCompacting) {
			return { ok: false, text: "Wait for the current response to finish or abort it before clearing." };
		}
		const result = await this.#session.resetSessionContext();
		if (result === undefined) {
			return { ok: false, text: "Wait for the current response to finish or abort it before clearing." };
		}
		// Display epoch splice (the rewind pattern): the translator re-seeds
		// from the post-boundary branch, the watermark jump makes every
		// resident client refetch the tail page, and the marker card documents
		// the reset in the fresh window.
		const clientTail = this.#translator.lastSeq;
		this.#translator.adoptEntries(this.#session.sessionManager.getBranch());
		this.#translator.skipTo(clientTail + 1);
		const sessionId = this.#session.sessionId;
		const markerId = `clear-${Date.now().toString(36)}`;
		const noun = result.droppedCount === 1 ? "message" : "messages";
		this.#emitCommandEvent(sessionId, this.#translator.appendCommandRun(markerId, "clear", ""));
		this.#emitCommandEvent(
			sessionId,
			this.#translator.appendCommandDone(
				markerId,
				"success",
				`Context reset — ${result.droppedCount} ${noun} dropped; session continues.`,
			),
		);
		return { ok: true, text: `Context reset — ${result.droppedCount} ${noun} dropped; session continues.` };
	}

	/** The /drop bridge (TUI handleDropCommand parity): delete + new session. */
	async #executeDropCommand(_sessionId: string): Promise<{ ok: boolean; text: string }> {
		if (!this.#session.sessionManager.getSessionFile()) {
			return { ok: false, text: "Nothing to drop (in-memory session)." };
		}
		if (this.#session.isStreaming || this.#session.isCompacting) {
			return { ok: false, text: "Cancel the current turn before dropping the session." };
		}
		const cwd = this.#session.sessionManager.getCwd();
		const switched = await this.#session.newSession({ drop: true });
		if (!switched) return { ok: false, text: "omp-web: drop was refused" };
		await this.#reconcileModesFromSession();
		this.#translator.adoptEntries(this.#session.sessionManager.getBranch());
		this.#sessionListCache = undefined;
		const nextSessionId = this.#session.sessionId;
		this.#emit({
			kind: "session-attached",
			sessionId: nextSessionId,
			lastSeq: this.#translator.lastSeq,
			queue: this.#queueSnapshot(),
			jobs: this.#jobsSnapshot(),
		});
		this.#emit({ kind: "session-added", sessionId: nextSessionId, blank: true, cwd });
		// No session-removed frame exists in the stream vocabulary; the dropped
		// session leaves the sidebar on the next list refetch.
		return { ok: true, text: "Session dropped; a fresh session is open." };
	}

	/**
	 * The /plan-review bridge: the TUI opens an approval overlay over the
	 * newest plan file; the web host renders the plan as a read-only command
	 * card (approval itself flows through the write-approval panel).
	 */
	async #executePlanReviewCommand(): Promise<{ ok: boolean; text: string }> {
		const localRoot = resolveLocalUrlToPath("local://", {
			getArtifactsDir: () => this.#session.sessionManager.getArtifactsDir(),
			getSessionId: () => this.#session.sessionManager.getSessionId(),
		});
		let entries: Dirent[];
		try {
			entries = await readdir(localRoot, { withFileTypes: true });
		} catch {
			return { ok: true, text: "No plan file found in this session yet." };
		}
		const plans: Array<{ name: string; mtime: number }> = [];
		for (const entry of entries) {
			if (!entry.isFile() || !/plan\.md$/i.test(entry.name)) continue;
			const stats = await stat(path.join(localRoot, entry.name)).catch(() => undefined);
			plans.push({ name: entry.name, mtime: stats?.mtimeMs ?? 0 });
		}
		if (plans.length === 0) return { ok: true, text: "No plan file found in this session yet." };
		const newest = plans.sort((left, right) => right.mtime - left.mtime)[0]!;
		const content = await readFile(path.join(localRoot, newest.name), "utf-8");
		if (content.trim() === "") return { ok: true, text: "No plan file found in this session yet." };
		return { ok: true, text: `Plan (${newest.name}):\n\n${content.trim()}` };
	}

	async cancel(sessionId: string): Promise<void> {
		await this.#ensureAttached(sessionId);
		// Settle parked approval/question gates FIRST: their select() promises
		// carry no abort signal, so abort() would otherwise wait forever on a
		// gate nobody can answer anymore (the turn unwinds with the gate
		// rejected, then abort drains the loop).
		this.#emit({ kind: "cancel-asks", sessionId, reason: "omp-web: session cancelled" });
		await this.#session.abort();
	}

	/**
	 * Reconcile agent-side plan/vibe/goal mode state with the persisted
	 * mode_change entries after attach/switch/new-session. The TUI does the
	 * same job in interactive-mode's #reconcileModeFromSession (installed on
	 * the identical hook); the web mirror keeps its established scope — mode
	 * state plus the tool set, without the TUI's status/registry machinery.
	 * Without it a mode active on the source session leaks into the switch
	 * target, and the UI's history-folded mode baseline diverges from what
	 * the agent actually enforces.
	 */
	async #reconcileModesFromSession(): Promise<void> {
		const context = this.#session.sessionManager.buildSessionContext();
		const mode = context.mode;

		// Plan: enter on a persisted plan mode; clear a leaked state otherwise.
		// A trailing plan_paused keeps the guardrail on — the history fold shows
		// plan active for it too, and conservative beats permissive for a
		// write-restricting mode.
		const planPersisted =
			(mode === "plan" || mode === "plan_paused") && cfgPlanEnabled.get(this.#session.settings) === true;
		if (planPersisted) {
			const planFilePath =
				(context.modeData?.planFilePath as string | undefined) ||
				this.#session.getPlanReferencePath() ||
				"local://PLAN.md";
			const tools = this.#session.getEnabledToolNames();
			this.#planModePreviousTools = tools;
			this.#session.setPlanModeState({ enabled: true, planFilePath, workflow: "parallel", reentry: false });
			if (this.#session.hasBuiltInTool("write") && !tools.includes("write")) {
				await this.#session.setActiveToolsByName([...tools, "write"]);
			}
		} else {
			if (this.#session.getPlanModeState() !== undefined) this.#session.setPlanModeState(undefined);
			// The snapshot belongs to the source session; applying it here would
			// clobber the target's tools (the TUI's own switch path discards it).
			this.#planModePreviousTools = undefined;
		}

		// Vibe: enter on a persisted vibe mode (the persisted previousTools are
		// the exit-restore target); strip a leaked install otherwise.
		if (mode === "vibe") {
			if (this.#session.getVibeModeState()?.enabled !== true) {
				this.#vibePreviousTools =
					readPersistedToolNames(context.modeData?.previousTools) ?? this.#session.getEnabledToolNames();
				const baseTools = this.#session.hasBuiltInTool("todo") ? ["read", "todo"] : ["read"];
				await this.#session.activateVibeTools(baseTools);
				this.#session.setVibeModeState({ enabled: true });
			}
		} else if (this.#session.getVibeModeState() !== undefined) {
			await this.#session.removeVibeToolsPreservingActive();
			this.#session.setVibeModeState(undefined);
			this.#vibePreviousTools = undefined;
		}

		// Goal: restore the persisted goal (the goal tool rejoins the set — the
		// SDK excludes it from the initial set unconditionally); clear leaks.
		const goal = mode === "goal" || mode === "goal_paused" ? goalFromModeData(context.modeData) : undefined;
		if (goal !== undefined && cfgGoalEnabled.get(this.#session.settings) !== false) {
			this.#session.setGoalModeState({ enabled: mode === "goal", mode: "active", goal });
			const tools = this.#session.getEnabledToolNames();
			if (!tools.includes("goal")) await this.#session.setActiveToolsByName([...tools, "goal"]);
		} else {
			this.#session.goalRuntime.clearAccounting();
			if (this.#session.getGoalModeState() !== undefined) {
				this.#session.setGoalModeState(undefined);
				const tools = this.#session.getEnabledToolNames();
				if (tools.includes("goal")) {
					await this.#session.setActiveToolsByName(tools.filter(name => name !== "goal"));
				}
			}
		}
	}

	/**
	 * The full-entry tree with current-path markers (the History view's data;
	 * TUI `/tree` vocabulary — see history-tree.ts).
	 */
	async historyTree(sessionId: string): Promise<{ nodes: WebHistoryNode[]; branchSummariesEnabled: boolean }> {
		logger.debug(`omp-web history: target=${sessionId} attached=${this.#session.sessionId}`);
		await this.#ensureAttached(sessionId);
		const manager = this.#session.sessionManager;
		const labels = new Map<string, string>();
		for (const entry of manager.getEntries()) {
			const label = manager.getLabel(entry.id);
			if (label !== undefined) labels.set(entry.id, label);
		}
		return {
			nodes: projectHistoryTree(manager.getEntries(), labels, manager.getLeafId()),
			branchSummariesEnabled: cfgBranchSummaryEnabled.get(this.#session.settings) === true,
		};
	}

	/** Rewind: move the session onto the path through one entry (TUI summarize-and-switch options ride along). */
	async navigateToEntry(
		sessionId: string,
		entryId: string,
		options?: { summarize?: boolean; customInstructions?: string },
	): Promise<{ editorText?: string; aborted?: boolean }> {
		await this.#ensureAttached(sessionId);
		// Rewinding abandons the in-flight turn: settle its parked asks before
		// navigateTree aborts, same deadlock avoidance as cancel().
		this.#emit({ kind: "cancel-asks", sessionId, reason: "omp-web: session rewound" });
		const result = await this.#session.navigateTree(entryId, {
			...(options?.summarize === true ? { summarize: true } : {}),
			...(options?.customInstructions !== undefined && options.customInstructions !== ""
				? { customInstructions: options.customInstructions }
				: {}),
		});
		if (result.cancelled) throw new Error("omp-web: navigation was cancelled");
		// The transcript rewound — the canonical log must re-seed from the new
		// path. A resident client, though, only rebuilds its conversation
		// window through its forward-gap repair (rewound seqs alone are
		// dropped as replay), so splice the epoch: jump the watermark past
		// every seq the client has seen and append a display-only rewind
		// marker. The gap makes the client refetch the tail page, whose
		// install replaces the whole window with the rewound truth.
		const clientTail = this.#translator.lastSeq;
		// Seed from the ACTIVE BRANCH only — every other entry is forked history.
		this.#translator.adoptEntries(this.#session.sessionManager.getBranch());
		this.#sessionListCache = undefined;
		this.#translator.skipTo(clientTail + 1);
		const markerId = `omp-history-rewind-${Date.now().toString(36)}`;
		this.#emitCommandEvent(sessionId, this.#translator.appendCommandRun(markerId, "rewind", `entry:${entryId}`));
		this.#emitCommandEvent(
			sessionId,
			this.#translator.appendCommandDone(markerId, "success", "rewound to the selected entry"),
		);
		return {
			...(result.editorText !== undefined && result.editorText !== "" ? { editorText: result.editorText } : {}),
			...(result.aborted === true ? { aborted: true } : {}),
		};
	}

	/** Sets or clears an entry label (the TUI tree's Shift+L). */
	async setEntryLabel(sessionId: string, entryId: string, label?: string): Promise<void> {
		await this.#ensureAttached(sessionId);
		this.#session.sessionManager.appendLabelChange(entryId, label === "" ? undefined : label);
	}

	/** Fork at a completed-turn boundary or an entry anchor; the child lands beside the source. */
	async fork(sessionId: string, anchor?: { atSeq?: number; entryId?: string }): Promise<{ sessionId: string }> {
		const infos = await this.#allSessionInfos();
		const info = infos.find(candidate => candidate.id === sessionId);
		if (info === undefined) throw new Error(`omp-web: no persisted session ${sessionId}`);
		if (sessionId === this.#session.sessionId) await this.#session.sessionManager.flush();
		const forked = await forkSessionFile(info.path, anchor);
		// Announce the child like createSession does, so the sidebar list
		// picks it up without waiting for a reconnect-driven refresh.
		this.#sessionListCache = undefined;
		this.#emit({
			kind: "session-added",
			sessionId: forked.sessionId,
			blank: false,
			...(info.cwd !== "" ? { cwd: info.cwd } : {}),
		});
		return forked;
	}

	async rename(sessionId: string, title: string): Promise<{ title: string; seq: number }> {
		await this.#ensureAttached(sessionId);
		const accepted = await this.#session.setSessionName(title, "user");
		if (!accepted) {
			throw new Error("omp-web: rename was refused");
		}
		this.#sessionListCache = undefined;
		const seq = this.#translator.nextSeq();
		this.#emit({ kind: "session-projection", sessionId, key: "title", value: title, seq });
		return { title, seq };
	}

	subscribe(listener: (event: WebStreamEvent) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async attachedSessions(): Promise<Array<{ sessionId: string; lastSeq: number }>> {
		return [{ sessionId: this.#session.sessionId, lastSeq: this.#translator.lastSeq }];
	}

	/** Switch the underlying session when the target is cold (TUI semantics). */
	async #ensureAttached(sessionId: string): Promise<void> {
		if (sessionId === this.#session.sessionId) return;
		// Serialize switches: page-load races (history, models, commands) target
		// one cold session, and every waiter joins the single flying switch.
		const inFlight = this.#attachInFlight;
		if (inFlight !== undefined) {
			await inFlight.catch(() => {});
			if (sessionId === this.#session.sessionId) return;
		}
		const task = this.#switchTo(sessionId);
		this.#attachInFlight = task;
		try {
			await task;
		} finally {
			if (this.#attachInFlight === task) this.#attachInFlight = undefined;
		}
	}

	async #switchTo(sessionId: string): Promise<void> {
		if (this.#session.isStreaming || this.#session.isCompacting) {
			throw new Error("omp-web: the attached session is busy; cancel it before switching");
		}
		const infos = await this.#allSessionInfos();
		const info = infos.find(candidate => candidate.id === sessionId);
		if (info === undefined) {
			throw new Error(`omp-web: no persisted session ${sessionId}`);
		}
		// A parked ask from a pre-fix turn would otherwise replay as a zombie on
		// every reconnect; the leaving session settles its gates.
		this.#emit({ kind: "cancel-asks", sessionId: this.#session.sessionId, reason: "omp-web: session switched" });
		const switched = await this.#session.switchSession(info.path);
		if (!switched) {
			throw new Error(`omp-web: switchSession was refused for ${sessionId}`);
		}
		// Seed from the ACTIVE BRANCH only — every other entry is forked history.
		this.#translator.adoptEntries(this.#session.sessionManager.getBranch());
		this.#sessionListCache = undefined;
		// The window moved: re-baseline the client's session runtime (fresh
		// Agent queues are empty; the snapshot documents that).
		this.#emit({
			kind: "session-attached",
			sessionId,
			lastSeq: this.#translator.lastSeq,
			queue: this.#queueSnapshot(),
			jobs: this.#jobsSnapshot(),
		});
	}

	#titleOfCurrent(): string | undefined {
		// The persisted title (explicit rename or auto-generated) always wins;
		// the first-user-message derivation is only the listing fallback. The
		// derivation reads the restored in-memory window, which may start after
		// a compaction and contain no user message at all (autonomous runs) —
		// the persisted title is immune to that.
		const persisted = this.#session.sessionManager.getSessionName();
		if (persisted !== undefined && persisted !== "") return persisted;
		const firstUser = this.#session.messages.find(
			(message): message is UserMessage =>
				message.role === "user" && message.steering !== true && message.synthetic !== true,
		);
		if (firstUser === undefined) return undefined;
		const content = firstUser.content;
		const text =
			typeof content === "string"
				? content
				: content.map(block => (block.type === "text" ? block.text : "")).join(" ");
		const trimmed = text.trim();
		return trimmed === "" ? undefined : trimmed.slice(0, 60);
	}
}
