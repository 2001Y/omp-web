import { describe, expect, test } from "bun:test";
import { isLoopbackHostname, isTrustedApiRequest } from "../src/server/trust";

function headers(entries: Record<string, string>): Headers {
	return new Headers(entries);
}

describe("isLoopbackHostname", () => {
	test("accepts localhost, IPv6 loopback, and any IPv4 address in 127/8", () => {
		expect(isLoopbackHostname("localhost")).toBe(true);
		expect(isLoopbackHostname("[::1]")).toBe(true);
		expect(isLoopbackHostname("127.0.0.1")).toBe(true);
		expect(isLoopbackHostname("127.255.0.3")).toBe(true);
		expect(isLoopbackHostname("128.0.0.1")).toBe(false);
		expect(isLoopbackHostname("127.0.999.1")).toBe(false);
		expect(isLoopbackHostname("example.com")).toBe(false);
	});
});

describe("isTrustedApiRequest", () => {
	test("a loopback Host passes without browser markers", () => {
		expect(isTrustedApiRequest(headers({ host: "127.0.0.1:3180" }), [])).toBe(true);
		expect(isTrustedApiRequest(headers({ host: "localhost:3180" }), [])).toBe(true);
	});

	test("a rebound Host (DNS rebinding) is refused", () => {
		expect(isTrustedApiRequest(headers({ host: "attacker.example" }), [])).toBe(false);
	});

	test("an explicit cross-site fetch marker is refused regardless of Origin", () => {
		expect(
			isTrustedApiRequest(
				headers({ host: "127.0.0.1:3180", origin: "http://127.0.0.1:3180", "sec-fetch-site": "cross-site" }),
				[],
			),
		).toBe(false);
	});

	test("an attached Origin must equal the Host authority", () => {
		expect(isTrustedApiRequest(headers({ host: "127.0.0.1:3180", origin: "http://evil.example" }), [])).toBe(false);
		expect(isTrustedApiRequest(headers({ host: "127.0.0.1:3180", origin: "http://127.0.0.1:3180" }), [])).toBe(true);
		expect(isTrustedApiRequest(headers({ host: "127.0.0.1:3180", origin: "null" }), [])).toBe(false);
	});

	test("a trusted non-loopback authority passes; others on the same host do not", () => {
		expect(isTrustedApiRequest(headers({ host: "192.168.1.4:3180" }), ["192.168.1.4"])).toBe(true);
		expect(isTrustedApiRequest(headers({ host: "192.168.1.5:3180" }), ["192.168.1.4"])).toBe(false);
		// A port-less entry matches the hostname on any port.
		expect(isTrustedApiRequest(headers({ host: "h.internal:9999" }), ["h.internal"])).toBe(true);
	});

	test("a missing Host header never passes", () => {
		expect(isTrustedApiRequest(new Headers(), [])).toBe(false);
	});
});
