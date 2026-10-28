/**
 * The bidirectional stream mux for the dsh 0.2.x host surface
 * (`/api/remote.mux`).
 *
 * One WebSocket carries every host-initiated stream: `$events` (host event
 * emits plus the two answerable waterfalls, `approval/request` and
 * `user-questions/request`), `session/follow` (one session's journal),
 * `session/control` (host-wide projection baselines and updates),
 * `workspace/follow` (the workspace list baseline), and
 * `remoteAccess/follow` (the caller's access baseline — always the owner
 * baseline on this single-principal host). Driver notifications
 * fan out onto the open subscriptions; journal events are forwarded only
 * in gap-free seq order — a gap ends the follow with an error frame rather
 * than silently skipping, per the journal contract.
 */

import * as logger from "@oh-my-pi/pi-utils/logger";
import type { WebDriver, WebStreamEvent } from "../protocol/driver";
import type { WebAskOutcome, WebAskRequest } from "../protocol/interactions";
import { parseApprovalResponse, parseQuestionResponse } from "../protocol/interactions";
import { projectionsBaseline } from "./session";
import { followSnapshot, requestArgs } from "./session";
import { gatewayInternal, remoteError, type RpcError, serviceUnavailable } from "./wire";

/** The socket surface the mux needs (Bun's ServerWebSocket satisfies it). */
export interface MuxSocket {
	send(data: string): unknown;
	close(code?: number, reason?: string): unknown;
	ping(): unknown;
	terminate?: () => unknown;
	readonly readyState: number;
}

interface FollowSub {
	kind: "follow";
	sessionId: string;
	/** Last journal seq delivered (or the snapshot cursor while opening). */
	lastSeq: number;
	/** Events buffered while the opening snapshot is being read. */
	buffered: WebStreamEvent[] | undefined;
}

interface EventsSub {
	kind: "$events";
}

interface ControlSub {
	kind: "control";
}

interface WorkspaceSub {
	kind: "workspace";
}

interface AccessSub {
	kind: "access";
}

type Sub = FollowSub | EventsSub | ControlSub | WorkspaceSub | AccessSub;

interface SocketState {
	clientId: string;
	subs: Map<string, Sub>;
	missedPongs: number;
}

/** One parked waterfall ask awaiting its `$events/result`. */
interface PendingAsk {
	eventId: string;
	clientId: string;
	sessionId: string;
	request: WebAskRequest;
	settle: (outcome: WebAskOutcome) => void;
	fail: (error: Error) => void;
}

const UPLINK_LIMIT_BYTES = 256 * 1024;

/** Endpoints this mux implements; anything else answers service-unavailable on open. */
const STREAM_ENDPOINTS = new Set(["$events", "session/follow", "session/control", "workspace/follow", "remoteAccess/follow"]);

/** The stream mux: socket registry, subscription engine, and driver fan-out. */
export class RemoteStreams {
	readonly #driver: WebDriver;
	readonly #sockets = new Map<MuxSocket, SocketState>();
	readonly #pendingAsks = new Map<string, PendingAsk>();
	#home: string | undefined;

	constructor(driver: WebDriver) {
		this.#driver = driver;
	}

	/** Register a freshly upgraded socket; returns its stream clientId. */
	attach(socket: MuxSocket): string {
		const clientId = crypto.randomUUID();
		this.#sockets.set(socket, { clientId, subs: new Map(), missedPongs: 0 });
		return clientId;
	}

	/** Drop a closed socket and fail its parked asks' delivery expectation. */
	detach(socket: MuxSocket): void {
		this.#sockets.delete(socket);
	}

	/** Note a pong (or any inbound frame): the peer is alive. */
	noteAlive(socket: MuxSocket): void {
		const state = this.#sockets.get(socket);
		if (state !== undefined) state.missedPongs = 0;
	}

	/** Periodic liveness sweep: ping every socket, terminate after two missed pongs. */
	sweepLiveness(): void {
		for (const [socket, state] of this.#sockets) {
			if (state.missedPongs >= 2) {
				try {
					socket.terminate?.() ?? socket.close(1001, "pong timeout");
				} catch {
					// Already gone.
				}
				this.#sockets.delete(socket);
				continue;
			}
			state.missedPongs += 1;
			try {
				socket.ping();
			} catch {
				// Send failures surface on close.
			}
		}
	}

	/** Handle one inbound text frame. */
	async handleMessage(socket: MuxSocket, text: string): Promise<void> {
		this.noteAlive(socket);
		const state = this.#sockets.get(socket);
		if (state === undefined) return;
		if (new TextEncoder().encode(text).length > UPLINK_LIMIT_BYTES) {
			socket.close(1009, "frame too large");
			return;
		}
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(text) as Record<string, unknown>;
		} catch {
			socket.close(1007, "invalid json");
			return;
		}
		const type = frame.type;
		const streamId = typeof frame.streamId === "string" ? frame.streamId : undefined;
		if (streamId === undefined || (type !== "open" && type !== "item" && type !== "end" && type !== "cancel")) {
			socket.close(1008, "invalid stream frame");
			return;
		}
		if (type === "open") {
			const endpoint = typeof frame.endpoint === "string" ? frame.endpoint : "";
			const payload = frame.payload as { args?: Record<string, unknown> } | undefined;
			const args = payload?.args ?? {};
			await this.#openStream(socket, state, streamId, endpoint, args);
			return;
		}
		if (type === "cancel" || type === "end") {
			state.subs.delete(streamId);
			return;
		}
		// Client items on host streams carry no meaning for this host yet
		// (answers arrive through `$events/result`); they are accepted and dropped.
	}

	/** Handle one driver notification: fan out onto subscriptions and `$events`. */
	handleNotification(notification: WebStreamEvent): void {
		switch (notification.kind) {
			case "session-event": {
				const { sessionId, event } = notification;
				this.#emit("$events", "api-session/activity", [{ sessionId, lastSeq: event.seq }]);
				for (const [socket, state] of this.#sockets) {
					for (const [streamId, sub] of state.subs) {
						if (sub.kind !== "follow" || sub.sessionId !== sessionId) continue;
						if (sub.buffered !== undefined) {
							sub.buffered.push(notification);
							continue;
						}
						if (event.seq <= sub.lastSeq) continue;
						if (event.seq !== sub.lastSeq + 1) {
							this.#sendError(socket, streamId, remoteError("session/event-gap", "omp-web: journal gap", { sessionId }));
							state.subs.delete(streamId);
							continue;
						}
						sub.lastSeq = event.seq;
						this.#sendItem(socket, streamId, { type: "event", event });
					}
				}
				break;
			}
			case "session-projection": {
				const frame = {
					type: "projection",
					sessionId: notification.sessionId,
					key: notification.key,
					value: notification.value,
					seq: notification.seq,
				};
				for (const [socket, state] of this.#sockets) {
					for (const [streamId, sub] of state.subs) {
						if (sub.kind === "control") this.#sendItem(socket, streamId, frame);
					}
				}
				break;
			}
			case "session-added":
				this.#emit("$events", "api-session/added", [{ sessionId: notification.sessionId }]);
				break;
			case "session-status":
				this.#emit("$events", "api-session/status", [
					{ sessionId: notification.sessionId, status: notification.running ? "running" : "idle" },
				]);
				break;
			case "session-attached":
				this.#emit("$events", "api-session/activity", [
					{ sessionId: notification.sessionId, lastSeq: notification.lastSeq },
				]);
				break;
			case "ask-requested": {
				const eventId = crypto.randomUUID();
				const clientId = this.#firstEventsClientId();
				this.#pendingAsks.set(eventId, {
					eventId,
					clientId: clientId ?? "",
					sessionId: notification.sessionId,
					request: notification.request,
					settle: notification.settle,
					fail: notification.fail,
				});
				const name = notification.request.kind === "approval" ? "approval/request" : "user-questions/request";
				const payload =
					notification.request.kind === "approval"
						? {
								sessionId: notification.sessionId,
								approvalId: notification.request.approval.approvalId,
								toolName: notification.request.approval.toolName,
								...(notification.request.approval.reason !== undefined
									? { reason: notification.request.approval.reason }
									: {}),
							}
						: { sessionId: notification.sessionId, questions: notification.request.questions };
				this.#emit("$events", name, [payload], eventId);
				break;
			}
			case "cancel-asks": {
				for (const ask of this.#pendingAsks.values()) {
					if (ask.sessionId !== notification.sessionId) continue;
					this.#pendingAsks.delete(ask.eventId);
					ask.fail(new Error(notification.reason));
				}
				break;
			}
			default:
				// session-queue / session-jobs / commands-changed have no 0.2.x
				// stream home yet (queue and jobs return with their controllers).
				break;
		}
	}

	/**
	 * Settle one waterfall from its `$events/result` call.
	 * @returns true when the eventId named a parked ask of that client.
	 */
	resolveEventResult(args: { clientId?: unknown; eventId?: unknown; outcome?: unknown }): boolean {
		if (typeof args.eventId !== "string") return false;
		const ask = this.#pendingAsks.get(args.eventId);
		if (ask === undefined) return false;
		if (typeof args.clientId === "string" && ask.clientId !== "" && args.clientId !== ask.clientId) return false;
		const outcome = args.outcome as { kind?: unknown; value?: unknown; error?: { message?: unknown } } | undefined;
		this.#pendingAsks.delete(args.eventId);
		if (outcome?.kind === "result") {
			if (ask.request.kind === "approval") {
				const parsed = parseApprovalResponse(outcome.value);
				if (parsed === undefined || parsed.approvalId !== ask.request.approval.approvalId) {
					ask.fail(new Error("omp-web: malformed approval result"));
					return true;
				}
				ask.settle({ kind: "approval", outcome: parsed.outcome });
				return true;
			}
			const parsed = parseQuestionResponse(outcome.value);
			if (parsed === undefined) {
				ask.fail(new Error("omp-web: malformed question result"));
				return true;
			}
			ask.settle({ kind: "question", answer: parsed.answer });
			return true;
		}
		const message =
			outcome?.kind === "rejected" && typeof outcome.error?.message === "string"
				? outcome.error.message
				: "omp-web: the client did not answer the ask";
		ask.fail(new Error(message));
		return true;
	}

	/** Fail every parked ask (server shutdown). */
	failAllAsks(reason: string): void {
		for (const ask of this.#pendingAsks.values()) ask.fail(new Error(reason));
		this.#pendingAsks.clear();
	}

	async #openStream(
		socket: MuxSocket,
		state: SocketState,
		streamId: string,
		endpoint: string,
		args: Record<string, unknown>,
	): Promise<void> {
		if (!STREAM_ENDPOINTS.has(endpoint)) {
			this.#sendError(socket, streamId, serviceUnavailable(endpoint));
			return;
		}
		try {
			if (endpoint === "$events") {
				state.subs.set(streamId, { kind: "$events" });
				if (this.#home === undefined) {
					this.#home = (await this.#driver.describeHost()).home;
				}
				// The ready marker must be the stream's first item: without it
				// the client's generation never stands up.
				this.#sendItem(socket, streamId, { type: "ready", clientId: state.clientId, host: { home: this.#home } });
				return;
			}
			if (endpoint === "session/control") {
				state.subs.set(streamId, { kind: "control" });
				const sessions = await this.#driver.listSessions();
				const projections: Record<string, { asOfSeq: number; values: Record<string, unknown> }> = {};
				for (const summary of sessions) {
					try {
						projections[summary.sessionId] = await projectionsBaseline(this.#driver, summary.sessionId);
					} catch (error) {
						logger.warn(
							`omp-web: control baseline failed for ${summary.sessionId}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
				this.#sendItem(socket, streamId, { type: "baseline", value: { projections } });
				return;
			}
			if (endpoint === "remoteAccess/follow") {
				state.subs.set(streamId, { kind: "access" });
				// This host's only principal is the owner: the opening frame is
				// the owner baseline, and grants never change afterwards.
				this.#sendItem(socket, streamId, { type: "baseline", owner: true });
				return;
			}
			if (endpoint === "workspace/follow") {
				state.subs.set(streamId, { kind: "workspace" });
				const { workspaces, archivedSessionIds } = await this.#driver.listWorkspaces();
				// The rc2 frame is a `baseline` whose value carries `items`
				// (WorkspaceView: ISO-8601 instants), not the 0.1.x `snapshot`
				// shape — the client silently drops the old frame, which left
				// the sidebar empty on every fresh page load.
				this.#sendItem(socket, streamId, {
					type: "baseline",
					value: {
						items: workspaces.map(workspace => {
							const updatedAt = new Date(workspace.updatedAt).toISOString();
							return {
								workspaceId: workspace.workspaceId,
								path: workspace.path,
								title: workspace.title,
								sessionIds: workspace.sessionIds,
								createdAt: updatedAt,
								updatedAt,
							};
						}),
						archivedSessionIds,
						pinnedSessionIds: [],
					},
				});
				return;
			}
			// session/follow (its request object rides under args.request, like
			// the unary session verbs — see requestArgs)
			const req = requestArgs(args);
			const address = req.address as { kind?: unknown; sessionId?: unknown } | undefined;
			if (address?.kind !== "session" || typeof address.sessionId !== "string") {
				this.#sendError(socket, streamId, remoteError("gateway/arguments-invalid", "omp-web: session/follow requires a session address"));
				return;
			}
			const sub: FollowSub = { kind: "follow", sessionId: address.sessionId, lastSeq: -1, buffered: [] };
			state.subs.set(streamId, sub);
			const snapshot = await followSnapshot(this.#driver, address.sessionId, {
				...(typeof req.maxMessages === "number" ? { maxMessages: req.maxMessages } : {}),
				...(req.assistantStream === true ? { assistantStream: true } : {}),
			});
			this.#sendItem(socket, streamId, snapshot);
			sub.lastSeq = snapshot.cursor;
			const buffered = sub.buffered ?? [];
			sub.buffered = undefined;
			for (const notification of buffered) {
				if (notification.kind === "session-event") this.handleNotification(notification);
			}
		} catch (error) {
			this.#sendError(
				socket,
				streamId,
				gatewayInternal(error instanceof Error ? error.message : String(error)),
			);
			state.subs.delete(streamId);
		}
	}

	#firstEventsClientId(): string | undefined {
		for (const state of this.#sockets.values()) {
			for (const sub of state.subs.values()) {
				if (sub.kind === "$events") return state.clientId;
			}
		}
		return undefined;
	}

	/** Broadcast one `$events` emit to every open events stream. */
	#emit(_channel: "$events", name: string, args: unknown[], eventId?: string): void {
		const value =
			eventId !== undefined ? { event: name, args, eventId } : { event: name, args };
		for (const [socket, state] of this.#sockets) {
			for (const [streamId, sub] of state.subs) {
				if (sub.kind === "$events") this.#sendItem(socket, streamId, value);
			}
		}
	}

	#sendItem(socket: MuxSocket, streamId: string, value: unknown): void {
		try {
			if (socket.readyState !== WebSocket.OPEN) return;
			socket.send(JSON.stringify({ type: "item", streamId, value }));
		} catch (error) {
			logger.warn(`omp-web: mux send failure: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	#sendError(socket: MuxSocket, streamId: string, error: RpcError): void {
		try {
			if (socket.readyState !== WebSocket.OPEN) return;
			socket.send(JSON.stringify({ type: "error", streamId, error }));
		} catch {
			// The socket is gone; the close handler cleans up.
		}
	}
}
