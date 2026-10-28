/**
 * Unary Remote dispatcher for the dsh 0.2.x host surface.
 *
 * Routes `POST /api/<namespace>/<method>` envelopes onto the
 * {@link WebDriver}. Claimed namespaces with no implementation answer the
 * canonical `gateway/service-unavailable` (the client folds it into a
 * per-feature failure and keeps running); unclaimed endpoints answer 404
 * at the HTTP layer, mirroring the gateway's claim discipline.
 */

import type { WebDriver, WebPromptPart, WebQueueAction } from "../protocol/driver";
import { followSnapshot, projectionsBaseline, sessionListValue, sessionPageValue } from "./session";
import {
	badRequest,
	type ClientRequest,
	gatewayInternal,
	methodUnavailable,
	remoteError,
	type RpcResult,
	type ServerResponse,
	serviceUnavailable,
	sessionNotFound,
} from "./wire";

/** Namespaces the 0.2.x gateway would claim for this host's surface. */
const KNOWN_NAMESPACES = new Set([
	"$events",
	"session",
	"skills",
	"fileReferences",
	"commands",
	"subagents",
	"goals",
	"job",
	"terminal",
	"workspace",
	"directoryPicker",
	"account",
	"settings",
	"credentials",
	"workspaceFiles",
	"fileUploads",
	"remoteAccess",
	"llm",
	"agentPresets",
	"schedule",
	"userQuestions",
	"permissionPresets",
	"pluginInventory",
	"pluginManager",
	"pluginMarket",
	"messageFeedback",
	"sessionReferenceResolver",
]);

/** Dispatch outcome: an envelope for the HTTP 200 body, or a bare HTTP status. */
export type UnaryOutcome = { status: 200; response: ServerResponse } | { status: 404 };

function ok(value: unknown): RpcResult<unknown> {
	return value === undefined ? { ok: true, value: undefined } : { ok: true, value };
}

function fail(code: string, message: string, details: Record<string, unknown> = {}): RpcResult<unknown> {
	return { ok: false, error: remoteError(code, message, details) };
}

type Args = Record<string, unknown>;

function stringArg(args: Args, name: string): string | undefined {
	const value = args[name];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function numberArg(args: Args, name: string): number | undefined {
	const value = args[name];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Prompt content parts: text and image ride through; file receipts need the upload surface (later phase). */
function parsePromptParts(raw: unknown): WebPromptPart[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const parts: WebPromptPart[] = [];
	for (const part of raw) {
		if (typeof part !== "object" || part === null) return undefined;
		const row = part as Record<string, unknown>;
		if (row.type === "text" && typeof row.text === "string") {
			parts.push({ type: "text", text: row.text });
		} else if (row.type === "image" && typeof row.mediaType === "string" && typeof row.data === "string") {
			parts.push({
				type: "image",
				mediaType: row.mediaType,
				data: row.data,
				...(typeof row.name === "string" ? { name: row.name } : {}),
			});
		} else {
			return undefined;
		}
	}
	return parts;
}

/** Queue actions: rc2 edit content is text-only blocks. */
function parseQueueAction(raw: unknown): WebQueueAction | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const action = raw as Record<string, unknown>;
	if (action.kind === "remove") return { kind: "remove" };
	if (action.kind === "steer") return { kind: "steer" };
	if (action.kind === "edit" && Array.isArray(action.content)) {
		const content: WebPromptPart[] = [];
		for (const block of action.content) {
			if (typeof block !== "object" || block === null) return undefined;
			const row = block as Record<string, unknown>;
			if (row.type !== "text" || typeof row.text !== "string") return undefined;
			content.push({ type: "text", text: row.text });
		}
		return { kind: "edit", content };
	}
	return undefined;
}

async function dispatchSession(driver: WebDriver, method: string, args: Args): Promise<RpcResult<unknown>> {
	switch (method) {
		case "list":
			return ok(await sessionListValue(driver));
		case "search": {
			const query = stringArg(args, "query");
			if (query === undefined) return fail("gateway/arguments-invalid", "omp-web: session/search requires query");
			return ok(await driver.searchSessions(query));
		}
		case "create": {
			const workspaceId = stringArg(args, "workspaceId") ?? stringArg(args, "cwd");
			const created = await driver.createSession({
				...(workspaceId !== undefined ? { workspaceId } : {}),
			});
			return ok(created);
		}
		case "selectModel": {
			const sessionId = stringArg(args, "sessionId");
			const provider = stringArg(args, "provider");
			const model = stringArg(args, "model");
			if (sessionId === undefined || provider === undefined || model === undefined) {
				return fail("gateway/arguments-invalid", "omp-web: session/selectModel requires sessionId, provider, model");
			}
			const reasoningEffort = stringArg(args, "reasoningEffort");
			return ok(
				await driver.selectModel(sessionId, {
					provider,
					model,
					...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
				}),
			);
		}
		case "initializeDefaultModel":
			// OMP resolves the default route internally; nothing to seed.
			return ok(undefined);
		case "modelCatalog": {
			const host = await driver.describeHost();
			const attached = await driver.attachedSessions();
			const anchor = attached[0]?.sessionId;
			let groups: unknown[] = [];
			let current = {
				provider: host.provider ?? "",
				model: host.model ?? "",
			};
			let routableProviders: string[] = [];
			if (anchor !== undefined) {
				const models = await driver.models(anchor);
				groups = models.groups;
				current = models.current;
				routableProviders = models.groups.map(group => group.id);
			}
			return ok({ default: current, routableProviders, groups, failures: [] });
		}
		case "canOpenWorkspacePath": {
			const host = await driver.describeHost();
			return ok(host.canOpenPath);
		}
		case "rename": {
			const sessionId = stringArg(args, "sessionId");
			const title = stringArg(args, "title");
			if (sessionId === undefined || title === undefined) {
				return fail("gateway/arguments-invalid", "omp-web: session/rename requires sessionId and title");
			}
			return ok(await driver.rename(sessionId, title));
		}
		case "fork": {
			const sessionId = stringArg(args, "sessionId");
			if (sessionId === undefined) {
				return fail("gateway/arguments-invalid", "omp-web: session/fork requires sessionId");
			}
			const atSeq = numberArg(args, "atSeq");
			return ok(await driver.fork(sessionId, { ...(atSeq !== undefined ? { atSeq } : {}) }));
		}
		case "prompt": {
			const sessionId = stringArg(args, "sessionId");
			if (sessionId === undefined) {
				return fail("gateway/arguments-invalid", "omp-web: session/prompt requires sessionId");
			}
			const parts = parsePromptParts(args.content);
			if (parts === undefined) {
				return fail("gateway/arguments-invalid", "omp-web: session/prompt requires text or image content parts");
			}
			await driver.prompt(sessionId, parts, { ...(args.mode === "steer" ? { mode: "steer" as const } : {}) });
			return ok({ accepted: true });
		}
		case "attachment": {
			const sessionId = stringArg(args, "sessionId");
			const attachmentId = stringArg(args, "attachmentId");
			if (sessionId === undefined || attachmentId === undefined) {
				return fail("gateway/arguments-invalid", "omp-web: session/attachment requires sessionId and attachmentId");
			}
			const found = await driver.sessionAttachment(sessionId, attachmentId);
			if (found === undefined) return { ok: false, error: sessionNotFound(sessionId) };
			return ok(found);
		}
		case "updateQueue": {
			const sessionId = stringArg(args, "sessionId");
			const itemId = stringArg(args, "itemId");
			const action = parseQueueAction(args.action);
			if (sessionId === undefined || itemId === undefined || action === undefined) {
				return fail(
					"gateway/arguments-invalid",
					"omp-web: session/updateQueue requires sessionId, itemId and a valid action",
				);
			}
			await driver.updateQueue(sessionId, itemId, action);
			return ok({ accepted: true });
		}
		case "cancel": {
			const sessionId = stringArg(args, "sessionId");
			if (sessionId === undefined) {
				return fail("gateway/arguments-invalid", "omp-web: session/cancel requires sessionId");
			}
			await driver.cancel(sessionId);
			return ok({ accepted: true });
		}
		case "page": {
			const address = args.address as { kind?: unknown; sessionId?: unknown } | undefined;
			if (address?.kind !== "session" || typeof address.sessionId !== "string") {
				return fail("gateway/arguments-invalid", "omp-web: session/page requires a session address");
			}
			const throughSeq = numberArg(args, "throughSeq");
			if (throughSeq === undefined) {
				return fail("gateway/arguments-invalid", "omp-web: session/page requires throughSeq");
			}
			return ok(
				await sessionPageValue(driver, {
					sessionId: address.sessionId,
					throughSeq,
					...(numberArg(args, "beforeSeq") !== undefined ? { beforeSeq: numberArg(args, "beforeSeq") } : {}),
					...(numberArg(args, "maxMessages") !== undefined ? { maxMessages: numberArg(args, "maxMessages") } : {}),
				}),
			);
		}
		case "projections": {
			const sessionId = stringArg(args, "sessionId");
			if (sessionId === undefined) {
				return fail("gateway/arguments-invalid", "omp-web: session/projections requires sessionId");
			}
			const baseline = await projectionsBaseline(driver, sessionId);
			return ok({ kind: "sequenced", ...baseline });
		}
		default:
			return { ok: false, error: methodUnavailable(`session/${method}`) };
	}
}

/**
 * Create the unary dispatcher bound to one driver.
 * @returns a handler mapping (endpoint, parsed envelope) to an outcome.
 */
export function createRemoteDispatcher(driver: WebDriver): {
	dispatch(endpoint: string, request: ClientRequest): Promise<UnaryOutcome>;
	/** Snapshot builder shared with the stream layer (follow opening frame). */
	followSnapshot: typeof followSnapshot;
} {
	return {
		followSnapshot,
		async dispatch(endpoint: string, request: ClientRequest): Promise<UnaryOutcome> {
			const respond = (result: RpcResult<unknown>): UnaryOutcome => ({
				status: 200,
				response: { type: "server-response", rpcId: request.rpcId, result },
			});
			const slash = endpoint.indexOf("/");
			const namespace = slash === -1 ? endpoint : endpoint.slice(0, slash);
			const method = slash === -1 ? "" : endpoint.slice(slash + 1);
			if (!KNOWN_NAMESPACES.has(namespace)) return { status: 404 };
			if (request.method !== endpoint) {
				return respond({ ok: false, error: badRequest(`omp-web: method field does not match endpoint ${endpoint}`) });
			}
			const payload = request.payload;
			if (
				typeof payload !== "object" ||
				payload === null ||
				Object.keys(payload).length !== 1 ||
				typeof payload.args !== "object" ||
				payload.args === null ||
				Array.isArray(payload.args)
			) {
				return respond({
					ok: false,
					error: badRequest("omp-web: payload must be an object whose only key is an args object"),
				});
			}
			try {
				if (namespace === "session") return respond(await dispatchSession(driver, method, payload.args));
				return respond({ ok: false, error: serviceUnavailable(endpoint) });
			} catch (error) {
				return respond({
					ok: false,
					error: gatewayInternal(error instanceof Error ? error.message : String(error)),
				});
			}
		},
	};
}
