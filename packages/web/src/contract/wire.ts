/**
 * Browser RPC wire contract consumed by the vendored dsh-web client stack.
 * Structural mirror of the four-quadrant message model from
 * `@deepseek-ai/dsh-host-apiproxy/api/rpc.ts` (see `dsh-web/PROVENANCE.md` in
 * the omp-web workspace root for the vendoring record). Only the members the
 * omp web host produces or parses are restated here; the vendored browser
 * bundles remain the single source of truth for the shapes.
 */

/** Business error slot of every result. */
export interface RpcError {
	code: string;
	message: string;
	details: Record<string, unknown>;
}

/** Business success/failure result: the result slot of a unary response. */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

/** Call initiated by the client (wire carrier: `POST /api/<method>` body). */
export interface ClientRequest {
	type: "client-request";
	rpcId: string;
	method: string;
	payload: unknown;
}

/** Response to a ClientRequest (wire carrier: the HTTP response body of that POST). */
export interface ServerResponse {
	type: "server-response";
	rpcId: string;
	result: RpcResult<unknown>;
}

/** Response to a ServerRequest (wire carrier: `POST /api/respond` body). */
export interface ClientResponse {
	type: "client-response";
	rpcId: string;
	result: RpcResult<unknown>;
}

/** Carrier receipt for a `/api/respond` POST. */
export type RpcReceipt = { accepted: true } | { accepted: false; reason: "not-pending" | "bad-response" };

/**
 * Message initiated by the host (wire carrier: a downlink stream text frame).
 * For event streams the `method` field carries the frame's own `payload.type`.
 */
export interface ServerRequest {
	type: "server-request";
	rpcId: string;
	method: string;
	payload: unknown;
}

/** The catch-all error code every unimplemented method folds into. */
export function internalError(message: string): RpcError {
	return { code: "internal", message, details: {} };
}
