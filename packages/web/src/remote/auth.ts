/**
 * Browser authentication for the dsh 0.2.x host surface.
 *
 * Port of `@deepseek-ai/dsh-client-connection` `browser-auth.ts` behavior:
 * a launch token (32 random bytes, base64url) presented once as
 * `?token=` on `GET /` is exchanged for a signed cookie
 * (`dsh-auth-<base64url(sha256(authority))>`, value
 * `v1.<payload>.<HMAC-SHA256>`, HttpOnly, SameSite=Strict, 30 days), and
 * `/connect?token=…&interactions=…` mints the v2 variant. The HMAC secret
 * is a host-local key persisted by the caller (an in-process secret would
 * invalidate every browser on restart); the launch token itself rotates
 * per server start.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Cookie payload: subject, issue/expiry stamps (seconds), client pin. */
interface CookiePayload {
	sub: "owner";
	iat: number;
	exp: number;
	clientId?: string;
}

const COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60;

function base64url(data: Buffer | string): string {
	return Buffer.from(data).toString("base64url");
}

/** One authority's cookie name (the authority is the request's Host header). */
export function authCookieName(authority: string): string {
	return `dsh-auth-${createHash("sha256").update(authority).digest("base64url")}`;
}

/** The launch-token + signed-cookie authenticator for one server. */
export class BrowserAuth {
	readonly #secret: Buffer;
	readonly #token: string;

	/**
	 * @param secret - the persisted HMAC key (32 bytes from the caller's store).
	 */
	constructor(secret: Buffer) {
		this.#secret = secret;
		this.#token = randomBytes(32).toString("base64url");
	}

	/** This server start's launch token (for the printed access URL). */
	get launchToken(): string {
		return this.#token;
	}

	/** Constant-time launch-token check. */
	isLaunchToken(candidate: string | null): boolean {
		if (candidate === null) return false;
		const a = Buffer.from(candidate);
		const b = Buffer.from(this.#token);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	/** Mint the Set-Cookie header value for one authority. */
	mintCookie(authority: string, version: 1 | 2, clientId?: string): string {
		const now = Math.floor(Date.now() / 1000);
		const payload: CookiePayload = {
			sub: "owner",
			iat: now,
			exp: now + COOKIE_TTL_SECONDS,
			...(clientId !== undefined ? { clientId } : {}),
		};
		const body = base64url(JSON.stringify(payload));
		const signature = createHmac("sha256", this.#secret).update(body).digest("base64url");
		const value = `v${String(version)}.${body}.${signature}`;
		return `${authCookieName(authority)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${String(COOKIE_TTL_SECONDS)}`;
	}

	/**
	 * Validate the request's auth cookie for its authority.
	 * @returns the cookie payload when signature and expiry check out.
	 */
	authenticate(headers: Headers): CookiePayload | undefined {
		const authority = headers.get("host");
		if (authority === null) return undefined;
		const name = authCookieName(authority);
		const header = headers.get("cookie");
		if (header === null) return undefined;
		for (const part of header.split(";")) {
			const eq = part.indexOf("=");
			if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
			const value = part.slice(eq + 1).trim();
			const match = /^v[12]\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(value);
			if (match === null) return undefined;
			const [, body, signature] = match as unknown as [string, string, string];
			const expected = createHmac("sha256", this.#secret).update(body).digest("base64url");
			const a = Buffer.from(signature);
			const b = Buffer.from(expected);
			if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined;
			try {
				const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CookiePayload;
				if (payload.sub !== "owner" || typeof payload.exp !== "number") return undefined;
				if (payload.exp < Math.floor(Date.now() / 1000)) return undefined;
				return payload;
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
}

/**
 * Load the persisted HMAC secret, creating it (mode 0600) when absent.
 * @param filePath - the caller-chosen secret file location.
 * @returns the 32-byte secret.
 */
export async function loadOrCreateAuthSecret(filePath: string): Promise<Buffer> {
	const file = Bun.file(filePath);
	if (await file.exists()) {
		const bytes = Buffer.from(await file.arrayBuffer());
		if (bytes.length === 32) return bytes;
	}
	const secret = randomBytes(32);
	await Bun.write(filePath, secret);
	try {
		const { chmod } = await import("node:fs/promises");
		await chmod(filePath, 0o600);
	} catch {
		// Permissions are best-effort on exotic filesystems; the file lives in the user's agent dir.
	}
	return secret;
}
