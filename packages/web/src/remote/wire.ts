/**
 * Browser wire contract for the dsh 0.2.x host surface (Typert Remote).
 *
 * Structural mirror of `@deepseek-ai/dsh-client-connection` and
 * `@deepseek-ai/dsh-api-session-controller` at dsh-v0.2.1-rc.2: unary calls
 * ride `POST /api/<namespace>/<method>` with a two-member envelope, and all
 * host-initiated traffic rides the single bidirectional stream mux at
 * `/api/remote.mux`. Only the members this host produces or parses are
 * restated here; the vendored browser bundles remain the source of truth.
 */

/** Business error slot of every result. */
export interface RpcError {
	code: string;
	message: string;
	details: Record<string, unknown>;
}

/** Business success/failure result: the result slot of a unary response. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

/** Call initiated by the client (wire carrier: `POST /api/<namespace>/<method>` body). */
export interface ClientRequest {
	type: "client-request";
	rpcId: string;
	/** Endpoint form, `<namespace>/<method>` — identical to the URL's tail. */
	method: string;
	/** Argument bag: exactly one key, `args`, holding a plain object. */
	payload: { args: Record<string, unknown> };
}

/** Response to a ClientRequest (wire carrier: the HTTP response body of that POST). */
export interface ServerResponse {
	type: "server-response";
	rpcId: string;
	result: RpcResult<unknown>;
}

/** One frame of the stream mux, client → host. Keys are exact; extras are a parse error. */
export type StreamClientFrame =
	| { type: "open"; streamId: string; endpoint: string; payload: { args: Record<string, unknown> } }
	| { type: "item"; streamId: string; value?: unknown }
	| { type: "end"; streamId: string }
	| { type: "cancel"; streamId: string };

/** One frame of the stream mux, host → client. Keys are exact; extras are a parse error. */
export type StreamHostFrame =
	| { type: "item"; streamId: string; value?: unknown }
	| { type: "error"; streamId: string; error: RpcError }
	| { type: "end"; streamId: string };

/** A Remote error with a namespaced code (`gateway/*`, `session/*`, …). */
export function remoteError(code: string, message: string, details: Record<string, unknown> = {}): RpcError {
	return { code, message, details };
}

/** The generic transport failure code (renamed from the 0.1.x `internal`). */
export function gatewayInternal(message: string): RpcError {
	return remoteError("gateway/internal", message);
}

/** The addressed namespace is known to the host but has no implementation yet. */
export function serviceUnavailable(endpoint: string): RpcError {
	return remoteError("gateway/service-unavailable", `omp-web: ${endpoint} is not implemented by this host`);
}

/** The namespace is implemented but the named method is not. */
export function methodUnavailable(endpoint: string): RpcError {
	return remoteError("gateway/method-unavailable", `omp-web: ${endpoint} is not implemented by this host`);
}

/** The envelope or argument bag failed validation before dispatch. */
export function badRequest(message: string): RpcError {
	return remoteError("gateway/bad-request", message);
}

/** The addressed session does not exist (or is not visible to this peer). */
export function sessionNotFound(sessionId: string): RpcError {
	return remoteError("session/not-found", `omp-web: no such session: ${sessionId}`, { sessionId });
}
