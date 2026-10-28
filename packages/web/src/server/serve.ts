/**
 * The omp web GUI host: one Bun.serve assembling the vendored dsh-web browser
 * stack (boot-graph-injected index, plugin bundles, `/api` RPC dispatch, and
 * the two downlink-only WebSocket event streams) over an injected
 * {@link WebDriver}. Pure glue per the omp-web fork rules: no presentation
 * code lives here — every visual byte comes from the vendored client stack.
 *
 * Stream wiring mirrors the dsh connection node half: the mux stream opens
 * with one `session/subscribed` baseline per attached session, then forwards
 * translated session events verbatim; the host stream carries session-added
 * and running-status flips. Client-originated WebSocket messages are a
 * protocol violation (upstream traffic stays on HTTP).
 */

import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { type ComposedBoot, composeBootGraph } from "../boot/graph";
import { bootInjections, renderIndexInjections } from "../boot/inject";
import type { ClientRequest, ClientResponse, RpcReceipt, ServerRequest, ServerResponse } from "../contract/wire";
import type { WebDriver, WebStreamEvent } from "../protocol/driver";
import {
	parseApprovalResponse,
	parseQuestionResponse,
	type WebAskOutcome,
	type WebAskRequest,
} from "../protocol/interactions";
import { createRpcDispatcher } from "./rpc";
import { serveStatic } from "./static";
import { isTrustedApiRequest } from "./trust";
import { buildZip } from "./zip";

/** Route prefix owning every api request. */
const API_PATH = "/api";

/** Browser mux-frame WebSocket pathname. */
const MUX_EVENTS_PATH = `${API_PATH}/events.mux`;

/** Browser host-frame WebSocket pathname. */
const HOST_EVENTS_PATH = `${API_PATH}/events.host`;

/** Default listen port (dsh serves 3080; omp takes a neighbor to coexist). */
const DEFAULT_PORT = 3180;

/** Downlink channel carried on one upgraded WebSocket. */
type DownlinkChannel = "mux" | "host";

/** Server assembly options. */
export interface WebServerOptions {
	/** The injected backend (implemented by the coding agent's web mode). */
	driver: WebDriver;
	/** Absolute path of the vendored dsh-web checkout. */
	dshRoot: string;
	/** Listen host; defaults to loopback. */
	hostname?: string;
	/** Listen port; zero requests an OS-assigned port. */
	port?: number;
	/** Non-loopback authorities this server is reached by (DNS-rebinding fence). */
	trustedHosts?: string[];
	/** Browser roster override; defaults to the full dsh web profile roster. */
	roster?: readonly string[];
}

/** Running server handle. */
export interface WebServerHandle {
	/** The canonical local URL. */
	url: string;
	/** The bound port (the OS-assigned value when zero was requested). */
	port: number;
	/** Stops accepting requests, terminates sockets, and resolves. */
	stop: () => Promise<void>;
}

/** Per-socket state Bun hands through `server.upgrade`. */
interface DownlinkState {
	channel: DownlinkChannel;
}

/**
 * Downlink fan-out: one WebSocket set over both channels, fed by the driver's
 * stream notifications. A send failure is contained (one broken consumer must
 * not kill the pump).
 */
class DownlinkHub {
	private readonly sockets = new Set<Bun.ServerWebSocket<DownlinkState>>();

	add(socket: Bun.ServerWebSocket<DownlinkState>): void {
		this.sockets.add(socket);
	}

	remove(socket: Bun.ServerWebSocket<DownlinkState>): void {
		this.sockets.delete(socket);
	}

	/**
	 * Wrap one server-request envelope and broadcast it to one channel's sockets.
	 * `rpcId` overrides the generated envelope id — answerable asks must reuse
	 * their ask id so the client's respond echoes it back to `/api/respond`.
	 */
	publish(channel: DownlinkChannel, method: string, payload: unknown, rpcId?: string): void {
		const frame: ServerRequest = { type: "server-request", rpcId: rpcId ?? crypto.randomUUID(), method, payload };
		const text = JSON.stringify(frame);
		for (const socket of this.sockets) {
			if (socket.data.channel !== channel || socket.readyState !== WebSocket.OPEN) continue;
			try {
				socket.send(text);
			} catch (error) {
				logger.warn(`omp-web: downlink send failure: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}

/** One answerable ask parked until its `/api/respond` lands. */
interface PendingAsk {
	sessionId: string;
	rpcId: string;
	request: WebAskRequest;
	settle: (outcome: WebAskOutcome) => void;
	fail: (error: Error) => void;
}

/**
 * The answerable-ask registry: every driver ask parks here keyed by its rpcId
 * until the browser responds. Mux (re)connection replays every still-pending
 * requested frame verbatim (rpcId reused — the refresh-recovery baseline).
 */
class PendingInteractions {
	private readonly pending = new Map<string, PendingAsk>();

	register(ask: PendingAsk): void {
		this.pending.set(ask.rpcId, ask);
	}

	/** Resolve one respond payload; unknown or mismatched ids answer not-pending. */
	respond(rpcId: string, value: unknown): "accepted" | "not-pending" | "bad-response" {
		const ask = this.pending.get(rpcId);
		if (ask === undefined) return "not-pending";
		if (ask.request.kind === "approval") {
			const parsed = parseApprovalResponse(value);
			if (parsed === undefined || parsed.approvalId !== ask.request.approval.approvalId) return "bad-response";
			this.pending.delete(rpcId);
			ask.settle({ kind: "approval", outcome: parsed.outcome });
			return "accepted";
		}
		const parsed = parseQuestionResponse(value);
		if (parsed === undefined) return "bad-response";
		this.pending.delete(rpcId);
		ask.settle({ kind: "question", answer: parsed.answer });
		return "accepted";
	}

	/** Fail one pending ask (the browser declined to answer). */
	cancel(rpcId: string, reason: string): boolean {
		const ask = this.pending.get(rpcId);
		if (ask === undefined) return false;
		this.pending.delete(rpcId);
		ask.fail(new Error(reason));
		return true;
	}

	/** Fail every pending ask (server shutdown). */
	failAll(reason: string): void {
		for (const ask of this.pending.values()) ask.fail(new Error(reason));
		this.pending.clear();
	}

	/**
	 * Fail every pending ask of one session (cancel/rewind/switch settles the
	 * gate as rejected), returning the failed asks so the caller broadcasts
	 * their resolved frames — the client drops the panel on that frame, never
	 * on the failure itself.
	 */
	failSession(sessionId: string, reason: string): PendingAsk[] {
		const failed: PendingAsk[] = [];
		for (const ask of this.pending.values()) {
			if (ask.sessionId !== sessionId) continue;
			this.pending.delete(ask.rpcId);
			ask.fail(new Error(reason));
			failed.push(ask);
		}
		return failed;
	}

	/** The requested frames to replay on a fresh mux connection, in ask order. */
	replayFrames(): Array<{ rpcId: string; method: string; payload: Record<string, unknown> }> {
		return [...this.pending.values()].map(ask => requestedFrame(ask));
	}
}

/** The wire frame one pending ask renders as. */
function requestedFrame(ask: PendingAsk): {
	rpcId: string;
	method: string;
	payload: Record<string, unknown>;
} {
	if (ask.request.kind === "approval") {
		return {
			rpcId: ask.rpcId,
			method: "approval/requested",
			payload: {
				type: "approval/requested",
				sessionId: ask.sessionId,
				approvalId: ask.request.approval.approvalId,
				toolName: ask.request.approval.toolName,
				...(ask.request.approval.reason !== undefined ? { reason: ask.request.approval.reason } : {}),
			},
		};
	}
	return {
		rpcId: ask.rpcId,
		method: "question/requested",
		payload: { type: "question/requested", sessionId: ask.sessionId, questions: ask.request.questions },
	};
}

/** Fold one driver stream notification onto its wire frame. */
function publishStreamEvent(hub: DownlinkHub, pending: PendingInteractions, notification: WebStreamEvent): void {
	switch (notification.kind) {
		case "session-event":
			hub.publish("mux", "session/event", {
				type: "session/event",
				sessionId: notification.sessionId,
				event: notification.event,
			});
			break;
		case "session-projection":
			hub.publish("mux", "session/projection", {
				type: "session/projection",
				sessionId: notification.sessionId,
				key: notification.key,
				value: notification.value,
				seq: notification.seq,
			});
			break;
		case "session-added":
			hub.publish("host", "host/session-added", {
				type: "host/session-added",
				sessionId: notification.sessionId,
				blank: notification.blank,
				...(notification.cwd !== undefined ? { cwd: notification.cwd } : {}),
			});
			break;
		case "session-status":
			hub.publish("host", "host/session-status", {
				type: "host/session-status",
				sessionId: notification.sessionId,
				running: notification.running,
			});
			break;
		case "session-jobs":
			hub.publish("mux", "session/jobs", {
				type: "session/jobs",
				sessionId: notification.sessionId,
				jobs: notification.jobs,
			});
			break;
		case "session-queue":
			hub.publish("mux", "session/queue", {
				type: "session/queue",
				sessionId: notification.sessionId,
				items: notification.items,
			});
			break;
		case "session-attached": {
			// Mirror the mux-open baseline: the subscribed frame is the client's
			// re-baseline anchor (queue mirror reset + projection truncation),
			// and a non-empty queue snapshot follows it on the same stream.
			hub.publish("mux", "session/subscribed", {
				type: "session/subscribed",
				sessionId: notification.sessionId,
				lastSeq: notification.lastSeq,
			});
			if (notification.queue.length > 0) {
				hub.publish("mux", "session/queue", {
					type: "session/queue",
					sessionId: notification.sessionId,
					items: notification.queue,
				});
			}
			if (notification.jobs !== undefined && notification.jobs.length > 0) {
				hub.publish("mux", "session/jobs", {
					type: "session/jobs",
					sessionId: notification.sessionId,
					jobs: notification.jobs,
				});
			}
			break;
		}
		case "commands-changed":
			// The client's command directory listens through remote.$on and
			// repulls every session key on this signal.
			hub.publish("mux", "commands/change", {});
			break;
		case "cancel-asks": {
			// The turn carrying these asks is unwinding (cancel/rewind/switch):
			// settle each parked gate promise, then drop the client panel with
			// the resolved counterpart frame (rejected / cancelled).
			for (const ask of pending.failSession(notification.sessionId, notification.reason)) {
				if (ask.request.kind === "approval") {
					hub.publish("mux", "approval/resolved", {
						type: "approval/resolved",
						sessionId: ask.sessionId,
						approvalId: ask.request.approval.approvalId,
						outcome: "rejected",
					});
				} else {
					hub.publish("mux", "question/resolved", {
						type: "question/resolved",
						sessionId: ask.sessionId,
						questionRpcId: ask.rpcId,
						outcome: "cancelled",
					});
				}
			}
			break;
		}
		case "ask-requested": {
			pending.register({
				sessionId: notification.sessionId,
				rpcId: notification.rpcId,
				request: notification.request,
				settle: notification.settle,
				fail: notification.fail,
			});
			const frame = requestedFrame({
				sessionId: notification.sessionId,
				rpcId: notification.rpcId,
				request: notification.request,
				settle: notification.settle,
				fail: notification.fail,
			});
			// The envelope id must equal the ask id: the client's respond echoes
			// the envelope rpcId, which `/api/respond` maps back onto this ask.
			hub.publish("mux", frame.method, frame.payload, frame.rpcId);
			break;
		}
	}
}

/** Compose the boot graph and pre-render the index once per server lifetime. */
async function prepareBootAssets(
	dshRoot: string,
	roster: readonly string[] | undefined,
): Promise<{ boot: ComposedBoot; indexHtml: string }> {
	const distIndex = path.join(dshRoot, "apps", "web", "dist", "index.html");
	const distIndexFile = Bun.file(distIndex);
	if (!(await distIndexFile.exists())) {
		throw new Error(`omp-web: frontend dist not found at ${distIndex} (build the dsh-web tree first)`);
	}
	const boot = await composeBootGraph(dshRoot, roster);
	const rawIndex = await distIndexFile.text();
	return { boot, indexHtml: renderIndexInjections(rawIndex, bootInjections(boot.graph)) };
}

/** Whether the pathname names one of the two downlink streams. */
function downlinkChannelOf(pathname: string): DownlinkChannel | undefined {
	if (pathname === MUX_EVENTS_PATH) return "mux";
	if (pathname === HOST_EVENTS_PATH) return "host";
	return undefined;
}

/**
 * Start the web GUI host.
 * @param options - assembly options; `driver` and `dshRoot` are required.
 * @returns the running server handle.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const hostname = options.hostname ?? "127.0.0.1";
	const port = options.port ?? DEFAULT_PORT;
	const trustedHosts = options.trustedHosts ?? [];
	const { boot, indexHtml } = await prepareBootAssets(options.dshRoot, options.roster);
	const dispatch = createRpcDispatcher(options.driver);
	const distRoot = path.join(options.dshRoot, "apps", "web", "dist");
	const distIndex = path.join(distRoot, "index.html");
	const hub = new DownlinkHub();
	const pending = new PendingInteractions();

	const unsubscribe = options.driver.subscribe(notification => {
		try {
			publishStreamEvent(hub, pending, notification);
		} catch (error) {
			logger.warn(`omp-web: stream pump failure: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	const server = Bun.serve<DownlinkState>({
		hostname,
		port,
		fetch: async (req: Request, srv: Bun.Server<DownlinkState>): Promise<Response | undefined> => {
			try {
				return await handleRequest(req, srv);
			} catch (error) {
				// Last-resort guard: one malformed request must never kill the process.
				logger.warn(`omp-web: request failure: ${error instanceof Error ? error.message : String(error)}`);
				return new Response(null, { status: 400 });
			}
		},
		websocket: {
			open: (ws: Bun.ServerWebSocket<DownlinkState>): void => {
				hub.add(ws);
				if (ws.data.channel !== "mux") return;
				// Mux baseline: one subscribed control frame per attached session
				// (the refresh-recovery anchor for its event stream).
				void options.driver
					.attachedSessions()
					.then(async attached => {
						for (const { sessionId, lastSeq } of attached) {
							hub.publish("mux", "session/subscribed", {
								type: "session/subscribed",
								sessionId,
								lastSeq,
							});
							// The queue snapshot follows its subscribed frame on the
							// same stream (the client clears its stale mirror there).
							const items = await options.driver.queuedMessages(sessionId);
							if (items.length > 0) {
								hub.publish("mux", "session/queue", {
									type: "session/queue",
									sessionId,
									items,
								});
							}
							// Same re-baseline rule for the job mirror.
							const jobs = await options.driver.sessionJobs(sessionId);
							if (jobs.length > 0) {
								hub.publish("mux", "session/jobs", {
									type: "session/jobs",
									sessionId,
									jobs,
								});
							}
						}
						// Refresh-recovery baseline: still-pending asks replay verbatim.
						for (const frame of pending.replayFrames()) {
							hub.publish("mux", frame.method, frame.payload, frame.rpcId);
						}
					})
					.catch(error => {
						logger.warn(
							`omp-web: mux baseline failure: ${error instanceof Error ? error.message : String(error)}`,
						);
					});
			},
			// Client messages are a protocol violation: upstream traffic stays on HTTP.
			message: (ws: Bun.ServerWebSocket<DownlinkState>): void => {
				ws.close(1008, "downlink only");
			},
			close: (ws: Bun.ServerWebSocket<DownlinkState>): void => {
				hub.remove(ws);
			},
		},
	});

	async function handleRequest(req: Request, server: Bun.Server<DownlinkState>): Promise<Response | undefined> {
		const rawPathname = new URL(req.url).pathname;
		if (rawPathname === API_PATH || rawPathname.startsWith(`${API_PATH}/`)) {
			return handleApi(req, server, rawPathname);
		}
		if (rawPathname.startsWith("/plugins/")) {
			return handlePluginBundle(req, new URL(req.url));
		}
		return serveStatic(decodeURIComponent(rawPathname), req.method, distRoot, distIndex, async () => indexHtml);
	}

	async function handleApi(
		req: Request,
		server: Bun.Server<DownlinkState>,
		rawPathname: string,
	): Promise<Response | undefined> {
		if (!isTrustedApiRequest(req.headers, trustedHosts)) {
			return new Response("forbidden", { status: 403 });
		}
		if (rawPathname === `${API_PATH}/session.export`) {
			return handleSessionExport(req);
		}
		const channel = downlinkChannelOf(rawPathname);
		if (channel !== undefined) {
			if (req.method !== "GET") {
				return new Response(null, { status: 405 });
			}
			if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
				return new Response("upgrade required", {
					status: 426,
					headers: { connection: "Upgrade", upgrade: "websocket" },
				});
			}
			if (server.upgrade(req, { data: { channel } })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		}
		if (req.method !== "POST") {
			return new Response(null, { status: 405 });
		}
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return new Response(null, { status: 400 });
		}
		if (rawPathname === `${API_PATH}/respond`) {
			return Response.json(respondReceipt(body, pending, hub));
		}
		if (typeof body !== "object" || body === null || (body as ClientRequest).type !== "client-request") {
			return new Response(null, { status: 400 });
		}
		const request = body as ClientRequest;
		const method = rawPathname.slice(API_PATH.length + 1);
		const response: ServerResponse = {
			type: "server-response",
			rpcId: request.rpcId,
			result: await dispatch(method, request.payload),
		};
		return Response.json(response);
	}

	/**
	 * The session-log download (`session-log-export` plugin): HEAD probes
	 * availability, GET serves the zip. Query: sessionId, includeDescendants.
	 */
	async function handleSessionExport(req: Request): Promise<Response> {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}
		const query = new URL(req.url).searchParams;
		const sessionId = query.get("sessionId");
		if (sessionId === null || sessionId === "") {
			return new Response(null, { status: 400 });
		}
		const archive = await options.driver.exportSessionLog(sessionId, query.get("includeDescendants") === "true");
		if (archive === undefined) {
			return new Response(null, { status: 404 });
		}
		const zip = buildZip(archive.entries);
		const headers = {
			"content-type": "application/zip",
			"content-disposition": `attachment; filename="omp-session-${sessionId}-logs.zip"`,
			"content-length": String(zip.length),
		};
		return new Response(req.method === "HEAD" ? null : zip, { status: 200, headers });
	}

	/** Fold a `/api/respond` POST into the carrier receipt, resolving the parked ask. */
	function respondReceipt(body: unknown, pending: PendingInteractions, hub: DownlinkHub): RpcReceipt {
		if (typeof body !== "object" || body === null || (body as ClientResponse).type !== "client-response") {
			return { accepted: false, reason: "bad-response" };
		}
		const response = body as ClientResponse;
		if (!response.result.ok) {
			// The browser declined to answer: fail the ask so the driver promise settles.
			pending.cancel(response.rpcId, `client declined: ${response.result.error.message}`);
			return { accepted: true };
		}
		// Peek the pending kind first so the resolved frame carries the right shape.
		const outcome = pending.respond(response.rpcId, response.result.value);
		if (outcome === "not-pending") return { accepted: false, reason: "not-pending" };
		if (outcome === "bad-response") return { accepted: false, reason: "bad-response" };
		publishResolvedFrame(hub, response.rpcId, response.result.value);
		return { accepted: true };
	}

	/** Broadcast the resolved counterpart frame for one settled ask. */
	function publishResolvedFrame(hub: DownlinkHub, rpcId: string, value: unknown): void {
		const approval = parseApprovalResponse(value);
		if (approval !== undefined) {
			hub.publish("mux", "approval/resolved", {
				type: "approval/resolved",
				sessionId: approval.sessionId,
				approvalId: approval.approvalId,
				outcome: approval.outcome,
			});
			return;
		}
		const question = parseQuestionResponse(value);
		if (question !== undefined) {
			hub.publish("mux", "question/resolved", {
				type: "question/resolved",
				sessionId: question.sessionId,
				questionRpcId: rpcId,
				outcome: "answered",
			});
		}
	}

	async function handlePluginBundle(req: Request, url: URL): Promise<Response> {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}
		// Combo form (dsh 0.2.x): `/plugins/??<id>/client.js,<id>/client.js&rev=<rev>`
		// — the `??` list lives in the query string; members are concatenated
		// in list order. Source-map members (`<id>/client.js.map`) work the same.
		if (url.pathname === "/plugins/" && url.search.startsWith("??")) {
			const list = url.search.slice(2).split("&", 1)[0] ?? "";
			const members = list.split(",").filter(member => member !== "");
			if (members.length === 0) return new Response(null, { status: 404 });
			const parts: string[] = [];
			let allMaps = true;
			for (const member of members) {
				const isMap = member.endsWith("/client.js.map");
				if (!isMap && !member.endsWith("/client.js")) return new Response(null, { status: 404 });
				if (!isMap) allMaps = false;
				const id = member.slice(0, member.lastIndexOf("/client.js"));
				const clientPath = boot.table.get(id)?.clientPath;
				if (clientPath === undefined) return new Response(null, { status: 404 });
				const file = Bun.file(isMap ? `${clientPath}.map` : clientPath);
				if (!(await file.exists())) return new Response(null, { status: 404 });
				if (req.method === "GET") parts.push(await file.text());
			}
			return new Response(req.method === "HEAD" ? null : parts.join("\n"), {
				status: 200,
				headers: {
					"content-type": allMaps ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8",
					"cache-control": "no-cache",
				},
			});
		}
		const pathname = decodeURIComponent(url.pathname);
		const prefix = "/plugins/";
		const mapSuffix = "/client.js.map";
		const bundleSuffix = "/client.js";
		const isSourceMap = pathname.startsWith(prefix) && pathname.endsWith(mapSuffix);
		const suffix = isSourceMap ? mapSuffix : bundleSuffix;
		const id =
			pathname.startsWith(prefix) && pathname.endsWith(suffix)
				? pathname.slice(prefix.length, -suffix.length)
				: undefined;
		const clientPath = id !== undefined ? boot.table.get(id)?.clientPath : undefined;
		const target = clientPath !== undefined ? `${clientPath}${isSourceMap ? ".map" : ""}` : undefined;
		if (target === undefined) {
			// Registered but unreadable (bundle not built): a loud 404 beats a silent SPA-fallback HTML page.
			return new Response(null, { status: 404 });
		}
		const file = Bun.file(target);
		if (!(await file.exists())) {
			return new Response(null, { status: 404 });
		}
		return new Response(req.method === "HEAD" ? null : file, {
			status: 200,
			headers: {
				"content-type": isSourceMap ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8",
				"cache-control": "no-cache",
			},
		});
	}

	const boundPort = server.port ?? port;
	const url = `http://${hostname}:${boundPort}`;
	return {
		url,
		port: boundPort,
		stop: async () => {
			unsubscribe();
			pending.failAll("omp-web: server stopped");
			server.stop(true);
		},
	};
}
