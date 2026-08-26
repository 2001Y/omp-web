/**
 * Browser-trust fence for every `/api` request and WebSocket upgrade.
 * Behavior port of `@deepseek-ai/dsh-client-connection`
 * `api-request-trust.ts` / `loopback-hostname.ts` (see PROVENANCE.md in the
 * omp-web workspace root): DNS-rebinding and cross-site defense, never an
 * authentication layer.
 */

/**
 * Whether a normalized URL hostname names the local loopback authority.
 * @param hostname - WHATWG URL hostname (IPv6 literals retain brackets).
 * @returns true for localhost, IPv6 loopback, or any IPv4 address in 127/8.
 */
export function isLoopbackHostname(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return (
		parts.length === 4 && parts[0] === "127" && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
	);
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
	try {
		return new URL(`http://${authority}`);
	} catch {
		return undefined;
	}
}

/**
 * Canonical form of a parsed authority: `hostname` when no port was written,
 * else `hostname:port`.
 */
function canonicalAuthority(entry: string, entryUrl: URL): string {
	const port = entryUrl.port !== "" ? entryUrl.port : new URL(`https://${entry}`).port;
	return port === "" ? entryUrl.hostname : `${entryUrl.hostname}:${port}`;
}

/** Whether the request authority matches a `trustedHosts` entry. */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
	return trustedHosts.some(entry => {
		const entryUrl = parseAuthority(entry);
		if (entryUrl === undefined) return false;
		return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
			? entryUrl.hostname === hostUrl.hostname
			: entryUrl.host === hostUrl.host;
	});
}

/**
 * Decide whether one `/api` request may reach the RPC bridge.
 * @param headers - request headers.
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the Host is ours (loopback or trusted) and any attached
 * browser markers are same-origin.
 */
export function isTrustedApiRequest(headers: Headers, trustedHosts: readonly string[]): boolean {
	const host = headers.get("host");
	if (host === null) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (headers.get("sec-fetch-site") === "cross-site") return false;
	const origin = headers.get("origin");
	if (origin === null) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
