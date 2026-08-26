/**
 * `/api` method dispatch: maps the browser RPC method set of the vendored
 * dsh-web client stack onto the injected {@link WebDriver}. Data adaptation
 * only — OMP domain state crossing into the client contract vocabulary.
 *
 * Implemented: `host.describe`, `session.list`, `session.create`,
 * `session.history`, `session.prompt`, `session.cancel`, `session.rename`,
 * `workspace.list` (storage-bucket-derived), and `skill.list` (the session's
 * user-invocable skills). Every other method — including generated Remote
 * endpoints (`<namespace>/<method>` payloads) — folds into the wire `internal`
 * error so the client surfaces a graceful failure instead of a transport break.
 */

import { internalError, type RpcResult } from "../contract/wire";
import type { WebDriver, WebHistoryOptions, WebSessionSummary } from "../protocol/driver";

/** Wire shape of one `session.list` row (SessionSummary in the dsh contract). */
interface SessionSummaryWire {
	sessionId: string;
	updatedAt: number;
	running: boolean;
	blank: boolean;
	parentSessionId?: string;
	origin?: "subagent";
	cwd?: string;
}

/** Wire shape of one `workspace.list` row (WorkspaceView in the dsh contract). */
interface WorkspaceViewWire {
	workspaceId: string;
	path: string;
	title: string;
	sessionIds: string[];
	createdAt: string;
	updatedAt: string;
}

/** Map one driver workspace view onto the wire vocabulary. */
function workspaceToWire(workspace: {
	workspaceId: string;
	path: string;
	title: string;
	sessionIds: readonly string[];
	updatedAt: number;
}): WorkspaceViewWire {
	return {
		workspaceId: workspace.workspaceId,
		path: workspace.path,
		title: workspace.title,
		sessionIds: [...workspace.sessionIds],
		// OMP storage tracks only the bucket's latest mtime; creation
		// time is unknown, so createdAt falls back to updatedAt.
		createdAt: new Date(workspace.updatedAt).toISOString(),
		updatedAt: new Date(workspace.updatedAt).toISOString(),
	};
}

/** Map one driver session summary onto the wire vocabulary. */
function sessionSummaryToWire(summary: WebSessionSummary): SessionSummaryWire {
	return {
		sessionId: summary.sessionId,
		updatedAt: summary.updatedAt,
		running: summary.running,
		blank: summary.blank,
		...(summary.parentSessionId !== undefined ? { parentSessionId: summary.parentSessionId } : {}),
		...(summary.origin !== undefined ? { origin: summary.origin } : {}),
		...(summary.cwd !== undefined ? { cwd: summary.cwd } : {}),
		// The sidebar row reads its title from the projections block; asOfSeq 0
		// keeps it below every live push frame under the higher-seq-wins rule.
		...(summary.title !== undefined ? { projections: { asOfSeq: 0, values: { title: summary.title } } } : {}),
	};
}

/**
 * Create the `/api` dispatcher over a driver.
 * @param driver - the injected backend.
 * @returns async method handler returning the wire result slot.
 */
export function createRpcDispatcher(
	driver: WebDriver,
): (method: string, payload: unknown) => Promise<RpcResult<unknown>> {
	return async (method: string, payload: unknown): Promise<RpcResult<unknown>> => {
		try {
			switch (method) {
				case "host.describe": {
					const host = await driver.describeHost();
					return {
						ok: true,
						value: {
							version: host.version,
							cwd: host.cwd,
							home: host.home,
							...(host.provider !== undefined ? { provider: host.provider } : {}),
							...(host.model !== undefined ? { model: host.model } : {}),
							attachedSessions: host.attachedSessions,
							canOpenPath: host.canOpenPath,
						},
					};
				}
				case "session.list": {
					const sessions = await driver.listSessions();
					return { ok: true, value: { items: sessions.map(sessionSummaryToWire) } };
				}
				case "session.create": {
					const request = (payload ?? {}) as { workspaceId?: string };
					const created = await driver.createSession({
						...(request.workspaceId !== undefined ? { workspaceId: request.workspaceId } : {}),
					});
					return { ok: true, value: created };
				}
				case "session.history": {
					const request = (payload ?? {}) as {
						sessionId?: string;
						beforeSeq?: number;
						maxMessages?: number;
					};
					if (typeof request.sessionId !== "string") {
						return { ok: false, error: internalError("omp-web: session.history requires sessionId") };
					}
					const options: WebHistoryOptions = {
						...(typeof request.beforeSeq === "number" ? { beforeSeq: request.beforeSeq } : {}),
						...(typeof request.maxMessages === "number" ? { maxMessages: request.maxMessages } : {}),
					};
					const history = await driver.history(request.sessionId, options);
					// Only the tail page (no beforeSeq anchor) seeds the projection baseline.
					const values: Record<string, unknown> = {};
					if (history.title !== undefined) values.title = history.title;
					if (history.plan !== undefined) values.plan = history.plan;
					if (history.goal !== undefined) values.goal = history.goal;
					if (history.imageLimits !== undefined) values.imageLimits = history.imageLimits;
					const projections =
						request.beforeSeq === undefined && Object.keys(values).length > 0
							? { asOfSeq: history.events.at(-1)?.seq ?? -1, values }
							: undefined;
					const entries = history.events.map(event => ({ event }));
					return {
						ok: true,
						value: {
							events: entries,
							hasMore: history.hasMore,
							...(projections !== undefined ? { projections } : {}),
						},
					};
				}
				case "session.prompt": {
					const request = (payload ?? {}) as {
						sessionId?: string;
						mode?: string;
						content?: Array<{ type?: string; text?: string; mediaType?: string; data?: string; name?: string }>;
					};
					if (typeof request.sessionId !== "string") {
						return { ok: false, error: internalError("omp-web: session.prompt requires sessionId") };
					}
					const parts = parsePromptParts(request.content);
					if (parts === undefined) {
						return { ok: false, error: internalError("omp-web: session.prompt requires content parts") };
					}
					await driver.prompt(request.sessionId, parts, {
						...(request.mode === "steer" ? { mode: "steer" as const } : {}),
					});
					return { ok: true, value: { accepted: true as const } };
				}
				case "session.updateQueue": {
					const request = (payload ?? {}) as {
						sessionId?: string;
						itemId?: string;
						action?: { kind?: string; content?: Array<{ type?: string; text?: string }> };
					};
					if (typeof request.sessionId !== "string" || typeof request.itemId !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: session.updateQueue requires sessionId and itemId"),
						};
					}
					const action = parseQueueAction(request.action);
					if (action === undefined) {
						return { ok: false, error: internalError("omp-web: session.updateQueue requires a valid action") };
					}
					await driver.updateQueue(request.sessionId, request.itemId, action);
					return { ok: true, value: { accepted: true as const } };
				}
				case "session.fork":
				case "ompHistory/forkAt": {
					const request = (payload ?? {}) as { sessionId?: string; atSeq?: number; entryId?: string };
					if (typeof request.sessionId !== "string") {
						return { ok: false, error: internalError(`omp-web: ${method} requires sessionId`) };
					}
					const forked = await driver.fork(request.sessionId, {
						...(typeof request.atSeq === "number" ? { atSeq: request.atSeq } : {}),
						...(typeof request.entryId === "string" ? { entryId: request.entryId } : {}),
					});
					return { ok: true, value: forked };
				}
				case "session.cancel": {
					const request = (payload ?? {}) as { sessionId?: string };
					if (typeof request.sessionId !== "string") {
						return { ok: false, error: internalError("omp-web: session.cancel requires sessionId") };
					}
					await driver.cancel(request.sessionId);
					return { ok: true, value: { accepted: true as const } };
				}
				case "session.rename": {
					const request = (payload ?? {}) as { sessionId?: string; title?: string };
					if (typeof request.sessionId !== "string" || typeof request.title !== "string") {
						return { ok: false, error: internalError("omp-web: session.rename requires sessionId and title") };
					}
					const renamed = await driver.rename(request.sessionId, request.title);
					return { ok: true, value: renamed };
				}
				case "session.search": {
					const request = (payload ?? {}) as { query?: string };
					if (typeof request.query !== "string" || request.query.trim() === "") {
						return { ok: false, error: internalError("omp-web: session.search requires query") };
					}
					return { ok: true, value: await driver.searchSessions(request.query.trim()) };
				}
				case "session.attachment": {
					const request = (payload ?? {}) as { sessionId?: string; attachmentId?: string };
					if (typeof request.sessionId !== "string" || typeof request.attachmentId !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: session.attachment requires sessionId and attachmentId"),
						};
					}
					const found = await driver.sessionAttachment(request.sessionId, request.attachmentId);
					if (found === undefined) {
						return { ok: false, error: { code: "not-found", message: "unknown attachment", details: {} } };
					}
					return { ok: true, value: found };
				}
				case "workspace.list": {
					const listed = await driver.listWorkspaces();
					return {
						ok: true,
						value: {
							items: listed.workspaces.map(workspaceToWire),
							archivedSessionIds: listed.archivedSessionIds,
						},
					};
				}
				case "workspace.create": {
					const request = (payload ?? {}) as { path?: string };
					if (typeof request.path !== "string" || request.path === "") {
						return { ok: false, error: internalError("omp-web: workspace.create requires path") };
					}
					const created = await driver.createWorkspace(request.path);
					return {
						ok: true,
						value: { workspace: workspaceToWire(created.workspace), created: created.created },
					};
				}
				case "workspace.rename": {
					const request = (payload ?? {}) as { workspaceId?: string; title?: string };
					if (typeof request.workspaceId !== "string" || typeof request.title !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: workspace.rename requires workspaceId and title"),
						};
					}
					const renamed = await driver.renameWorkspace(request.workspaceId, request.title);
					return { ok: true, value: { workspace: workspaceToWire(renamed.workspace) } };
				}
				case "workspace.delete": {
					const request = (payload ?? {}) as { workspaceId?: string };
					if (typeof request.workspaceId !== "string") {
						return { ok: false, error: internalError("omp-web: workspace.delete requires workspaceId") };
					}
					await driver.deleteWorkspace(request.workspaceId);
					return { ok: true, value: { deleted: true } };
				}
				case "workspace.insertBefore": {
					const request = (payload ?? {}) as { workspaceId?: string; beforeWorkspaceId?: string };
					if (typeof request.workspaceId !== "string") {
						return { ok: false, error: internalError("omp-web: workspace.insertBefore requires workspaceId") };
					}
					const moved = await driver.insertWorkspaceBefore(
						request.workspaceId,
						typeof request.beforeWorkspaceId === "string" ? request.beforeWorkspaceId : undefined,
					);
					return { ok: true, value: { workspaceIds: moved.workspaceIds } };
				}
				case "workspace.insertSessionBefore": {
					const request = (payload ?? {}) as {
						workspaceId?: string;
						sessionId?: string;
						beforeSessionId?: string;
					};
					if (typeof request.workspaceId !== "string" || typeof request.sessionId !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: workspace.insertSessionBefore requires workspaceId and sessionId"),
						};
					}
					const moved = await driver.insertSessionBefore(
						request.workspaceId,
						request.sessionId,
						typeof request.beforeSessionId === "string" ? request.beforeSessionId : undefined,
					);
					return { ok: true, value: { workspace: workspaceToWire(moved.workspace) } };
				}
				case "workspace.archiveSession": {
					const request = (payload ?? {}) as { sessionId?: string };
					if (typeof request.sessionId !== "string") {
						return { ok: false, error: internalError("omp-web: workspace.archiveSession requires sessionId") };
					}
					return { ok: true, value: await driver.archiveSession(request.sessionId) };
				}
				case "host.listDirectory": {
					const request = (payload ?? {}) as { path?: string };
					return {
						ok: true,
						value: await driver.listDirectory(typeof request.path === "string" ? request.path : undefined),
					};
				}
				case "host.createDirectory": {
					const request = (payload ?? {}) as { path?: string; name?: string };
					if (typeof request.path !== "string" || typeof request.name !== "string") {
						return { ok: false, error: internalError("omp-web: host.createDirectory requires path and name") };
					}
					return { ok: true, value: await driver.createDirectory(request.path, request.name) };
				}
				case "session.models": {
					const request = (payload ?? {}) as { sessionId?: string };
					if (typeof request.sessionId !== "string") {
						return { ok: false, error: internalError("omp-web: session.models requires sessionId") };
					}
					const models = await driver.models(request.sessionId);
					return { ok: true, value: { ...models, failures: [] } };
				}
				case "session.selectModel": {
					const request = (payload ?? {}) as {
						sessionId?: string;
						provider?: string;
						model?: string;
						reasoningEffort?: string;
					};
					if (
						typeof request.sessionId !== "string" ||
						typeof request.provider !== "string" ||
						typeof request.model !== "string"
					) {
						return {
							ok: false,
							error: internalError("omp-web: session.selectModel requires sessionId, provider, model"),
						};
					}
					const selected = await driver.selectModel(request.sessionId, {
						provider: request.provider,
						model: request.model,
						...(typeof request.reasoningEffort === "string" ? { reasoningEffort: request.reasoningEffort } : {}),
					});
					return { ok: true, value: selected };
				}
				case "agentPreset.list":
					// omp composes one agent; the preset vocabulary (per-preset tool
					// compositions) has no omp counterpart, so the section lists none.
					return { ok: true, value: { presets: [], authorable: false, hasDocument: false } };
				case "subagent.history": {
					const request = (payload ?? {}) as {
						parentSessionId?: string;
						childSessionId?: string;
						mode?: string;
						beforeSeq?: number;
						maxMessages?: number;
					};
					if (typeof request.parentSessionId !== "string" || typeof request.childSessionId !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: subagent.history requires parentSessionId and childSessionId"),
						};
					}
					const options: WebHistoryOptions = {
						...(typeof request.beforeSeq === "number" ? { beforeSeq: request.beforeSeq } : {}),
						...(typeof request.maxMessages === "number" ? { maxMessages: request.maxMessages } : {}),
					};
					const history = await driver.subagentHistory(request.parentSessionId, request.childSessionId, options);
					const values: Record<string, unknown> = {};
					if (history.title !== undefined) values.title = history.title;
					if (history.plan !== undefined) values.plan = history.plan;
					if (history.goal !== undefined) values.goal = history.goal;
					if (history.imageLimits !== undefined) values.imageLimits = history.imageLimits;
					const projections =
						request.beforeSeq === undefined && Object.keys(values).length > 0
							? { asOfSeq: history.events.at(-1)?.seq ?? -1, values }
							: undefined;
					const entries = history.events.map(event => ({ event }));
					return {
						ok: true,
						value: {
							events: entries,
							hasMore: history.hasMore,
							...(projections !== undefined ? { projections } : {}),
						},
					};
				}
				case "subagent.prompt": {
					const request = (payload ?? {}) as {
						parentSessionId?: string;
						childSessionId?: string;
						content?: Array<{ type?: string; text?: string; mediaType?: string; data?: string; name?: string }>;
					};
					if (typeof request.parentSessionId !== "string" || typeof request.childSessionId !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: subagent.prompt requires parentSessionId and childSessionId"),
						};
					}
					const content = parsePromptParts(request.content);
					if (content === undefined) {
						return { ok: false, error: internalError("omp-web: subagent.prompt requires content parts") };
					}
					return {
						ok: true,
						value: await driver.promptSubagent(request.parentSessionId, request.childSessionId, content),
					};
				}
				case "subagent.interrupt": {
					const request = (payload ?? {}) as { parentSessionId?: string; childSessionId?: string };
					if (typeof request.parentSessionId !== "string" || typeof request.childSessionId !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: subagent.interrupt requires parentSessionId and childSessionId"),
						};
					}
					await driver.interruptSubagent(request.parentSessionId, request.childSessionId);
					return { ok: true, value: { accepted: true as const } };
				}
				case "goals/create": {
					const args = (payload as { args?: { agentId?: string; request?: { objective?: string } } } | undefined)
						?.args;
					if (typeof args?.agentId !== "string" || typeof args.request?.objective !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: goals/create requires args.agentId and objective"),
						};
					}
					return { ok: true, value: await driver.goalCreate(args.agentId, args.request.objective) };
				}
				case "goals/edit":
				case "goals/pause":
				case "goals/resume":
				case "goals/complete":
				case "goals/clear": {
					const args = (
						payload as
							| {
									args?: {
										agentId?: string;
										ref?: { id?: string; revision?: number };
										request?: { objective?: string; maxGoalRounds?: number };
									};
							  }
							| undefined
					)?.args;
					if (
						typeof args?.agentId !== "string" ||
						typeof args.ref?.id !== "string" ||
						typeof args.ref?.revision !== "number"
					) {
						return { ok: false, error: internalError(`omp-web: ${method} requires args.agentId and args.ref`) };
					}
					const ref = { id: args.ref.id, revision: args.ref.revision };
					switch (method) {
						case "goals/edit":
							return {
								ok: true,
								value: await driver.goalEdit(args.agentId, ref, {
									...(typeof args.request?.objective === "string"
										? { objective: args.request.objective }
										: {}),
									...(typeof args.request?.maxGoalRounds === "number"
										? { maxGoalRounds: args.request.maxGoalRounds }
										: {}),
								}),
							};
						case "goals/pause":
							return { ok: true, value: await driver.goalPause(args.agentId, ref) };
						case "goals/resume":
							return { ok: true, value: await driver.goalResume(args.agentId, ref) };
						case "goals/complete":
							return { ok: true, value: await driver.goalComplete(args.agentId, ref) };
						default:
							return { ok: true, value: await driver.goalClear(args.agentId, ref) };
					}
				}
				case "subagent.list": {
					const request = (payload ?? {}) as { parentSessionId?: string };
					if (typeof request.parentSessionId !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: subagent.list requires parentSessionId"),
						};
					}
					const catalog = await driver.listSubagents(request.parentSessionId);
					return {
						ok: true,
						value: {
							parentAvailable: catalog.parentAvailable,
							entries: catalog.entries.map(entry => ({
								kind: "child" as const,
								id: entry.id,
								activity: entry.activity,
								hasChildren: entry.hasChildren,
								mode: entry.mode,
								...(entry.label !== undefined ? { label: entry.label } : {}),
							})),
						},
					};
				}
				case "settings.describe": {
					const overview = await driver.settingsOverview();
					const sections = await driver.clientSettingNamespaces();
					// Namespace schemas (the schemastery envelope mapping) arrive with
					// the section bridge; the client-client namespaces meanwhile ride a
					// permissive empty object schema (writes are host-validated).
					const namespaces = sections.map(section => namespaceView(section));
					return { ok: true, value: { ...overview, namespaces } };
				}
				case "settings.openDocument": {
					await driver.openSettingsDocument();
					return { ok: true, value: { opened: true as const } };
				}
				case "ompSettings/describe":
					return { ok: true, value: await driver.ompSettingsCatalog() };
				case "ompSettings/update": {
					const request = (payload ?? {}) as { key?: string; value?: unknown };
					if (typeof request.key !== "string") {
						return { ok: false, error: internalError("omp-web: ompSettings/update requires key") };
					}
					await driver.setOmpSetting(request.key, request.value);
					return { ok: true, value: { accepted: true as const } };
				}
				case "ompSettings/logoutProvider": {
					const request = (payload ?? {}) as { provider?: string };
					if (typeof request.provider !== "string") {
						return { ok: false, error: internalError("omp-web: ompSettings/logoutProvider requires provider") };
					}
					await driver.logoutProvider(request.provider);
					return { ok: true, value: { accepted: true as const } };
				}
				case "ompSettings/setModelRole": {
					const request = (payload ?? {}) as { role?: string; model?: string; thinking?: string };
					if (typeof request.role !== "string") {
						return { ok: false, error: internalError("omp-web: ompSettings/setModelRole requires role") };
					}
					await driver.setModelRole(
						request.role,
						request.model !== undefined && request.model !== ""
							? {
									model: request.model,
									...(request.thinking !== undefined ? { thinking: request.thinking } : {}),
								}
							: undefined,
					);
					return { ok: true, value: { accepted: true as const } };
				}
				case "settings.mutate":
				case "settings.update": {
					const request = (payload ?? {}) as {
						ns?: string;
						ops?: Array<{ op?: string; path?: string[]; value?: unknown }>;
						patch?: Record<string, unknown>;
					};
					if (typeof request.ns !== "string") {
						return { ok: false, error: internalError("omp-web: settings write requires ns") };
					}
					const ops: Array<{ op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] }> = [];
					if (method === "settings.update" && request.patch !== undefined) {
						for (const [key, value] of Object.entries(request.patch)) {
							ops.push({ op: "set", path: [key], value });
						}
					} else {
						for (const op of request.ops ?? []) {
							if (op.op === "set" && Array.isArray(op.path)) {
								ops.push({ op: "set", path: op.path, value: op.value });
							} else if (op.op === "unset" && Array.isArray(op.path)) {
								ops.push({ op: "unset", path: op.path });
							} else {
								return {
									ok: false,
									error: internalError("omp-web: settings write requires valid ops"),
								};
							}
						}
					}
					const section = await driver.mutateClientSetting(request.ns, ops);
					return { ok: true, value: namespaceView(section) };
				}
				case "ompHistory/tree": {
					const request = (payload ?? {}) as { sessionId?: string };
					if (typeof request.sessionId !== "string") {
						return { ok: false, error: internalError("omp-web: ompHistory/tree requires sessionId") };
					}
					return { ok: true, value: await driver.historyTree(request.sessionId) };
				}
				case "ompHistory/navigate": {
					const request = (payload ?? {}) as {
						sessionId?: string;
						entryId?: string;
						summarize?: boolean;
						customInstructions?: string;
					};
					if (typeof request.sessionId !== "string" || typeof request.entryId !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: ompHistory/navigate requires sessionId and entryId"),
						};
					}
					const navigated = await driver.navigateToEntry(request.sessionId, request.entryId, {
						...(request.summarize === true ? { summarize: true } : {}),
						...(typeof request.customInstructions === "string" && request.customInstructions !== ""
							? { customInstructions: request.customInstructions }
							: {}),
					});
					return { ok: true, value: navigated };
				}
				case "ompHistory/label": {
					const request = (payload ?? {}) as { sessionId?: string; entryId?: string; label?: string };
					if (typeof request.sessionId !== "string" || typeof request.entryId !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: ompHistory/label requires sessionId and entryId"),
						};
					}
					await driver.setEntryLabel(request.sessionId, request.entryId, request.label);
					return { ok: true, value: null };
				}
				case "commands/list": {
					const args = (payload as { args?: { agentId?: string } } | undefined)?.args;
					if (typeof args?.agentId !== "string") {
						return { ok: false, error: internalError("omp-web: commands/list requires args.agentId") };
					}
					return { ok: true, value: await driver.listCommands(args.agentId) };
				}
				case "fileReferences/list": {
					const args = (payload as { args?: { agentId?: string; query?: string } } | undefined)?.args;
					if (typeof args?.agentId !== "string") {
						return { ok: false, error: internalError("omp-web: fileReferences/list requires args.agentId") };
					}
					return {
						ok: true,
						value: await driver.listFileReferences(args.agentId, args.query ?? ""),
					};
				}
				case "commands/execute": {
					const args = (payload as { args?: { agentId?: string; line?: string } } | undefined)?.args;
					if (typeof args?.agentId !== "string" || typeof args.line !== "string") {
						return {
							ok: false,
							error: internalError("omp-web: commands/execute requires args.agentId and args.line"),
						};
					}
					return { ok: true, value: await driver.executeCommand(args.agentId, args.line) };
				}
				case "skill.list": {
					const request = (payload ?? {}) as { sessionId?: string };
					if (typeof request.sessionId !== "string") {
						return { ok: false, error: internalError("omp-web: skill.list requires sessionId") };
					}
					return { ok: true, value: { skills: await driver.listSkills(request.sessionId) } };
				}
				default:
					return { ok: false, error: internalError(`omp-web: method "${method}" is not implemented yet`) };
			}
		} catch (error) {
			return { ok: false, error: internalError(error instanceof Error ? error.message : String(error)) };
		}
	};
}

/** Narrow one updateQueue action payload onto the driver action union. */
function parseQueueAction(
	action: { kind?: string; content?: Array<{ type?: string; text?: string }> } | undefined,
): import("../protocol/driver").WebQueueAction | undefined {
	if (action?.kind === "remove") return { kind: "remove" };
	if (action?.kind === "steer") return { kind: "steer" };
	if (action?.kind === "edit" && Array.isArray(action.content)) {
		const parts = action.content
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
			)
			.map(part => ({ type: "text" as const, text: part.text }));
		return { kind: "edit", content: parts };
	}
	return undefined;
}

/** Parse the wire content-part array (text parts and base64 image parts). */
function parsePromptParts(
	content: Array<{ type?: string; text?: string; mediaType?: string; data?: string; name?: string }> | undefined,
): import("../protocol/driver").WebPromptPart[] | undefined {
	if (!Array.isArray(content)) return [];
	const parts: import("../protocol/driver").WebPromptPart[] = [];
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") {
			parts.push({ type: "text", text: part.text });
			continue;
		}
		if (part.type === "image" && typeof part.data === "string" && typeof part.mediaType === "string") {
			parts.push({
				type: "image",
				mediaType: part.mediaType,
				data: part.data,
				...(typeof part.name === "string" ? { name: part.name } : {}),
			});
			continue;
		}
		return undefined;
	}
	return parts;
}

/** The wire view of one browser-client settings namespace (loose object). */
function namespaceView(section: { ns: string; value: Record<string, unknown> }): Record<string, unknown> {
	return {
		ns: section.ns,
		schema: { type: "object", dict: {}, meta: { loose: true } },
		value: section.value,
		applies: "live",
		secrets: [],
		revision: 0,
	};
}
