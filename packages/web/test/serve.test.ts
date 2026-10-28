import { afterEach, describe, expect, test } from "bun:test";
import { startWebServer, type WebServerHandle } from "../src/server/serve";
import type { WebHistoryResult, WebStreamEvent } from "../src/protocol/driver";
import { fakeDriver } from "./fake-driver";
import { buildFixtureTree, type FixtureTree } from "./helpers";

const SERVERS: WebServerHandle[] = [];
const TREES: FixtureTree[] = [];

afterEach(async () => {
	await Promise.all(SERVERS.splice(0).map(server => server.stop()));
	await Promise.all(TREES.splice(0).map(tree => tree.cleanup()));
});

async function startFixtureServer(
	overrides: Parameters<typeof fakeDriver>[0] = {},
): Promise<{ server: WebServerHandle; driver: ReturnType<typeof fakeDriver>; cookie: string }> {
	const tree = await buildFixtureTree([
		{ id: "@deepseek-ai/dsh-client-modules" },
		{ id: "@deepseek-ai/dsh-client-runtime" },
		{ id: "@deepseek-ai/dsh-client-ui-demo", external: ["@deepseek-ai/dsh-client-modules"] },
	]);
	TREES.push(tree);
	const roster = [
		"@deepseek-ai/dsh-client-modules",
		"@deepseek-ai/dsh-client-runtime",
		"@deepseek-ai/dsh-client-ui-demo",
	];
	const driver = fakeDriver(overrides);
	const server = await startWebServer({
		driver,
		dshRoot: tree.root,
		port: 0,
		roster,
		authSecretPath: `${tree.root}/auth.key`,
	});
	SERVERS.push(server);
	const redemption = await fetch(server.accessUrl, { redirect: "manual" });
	expect(redemption.status).toBe(303);
	const setCookie = redemption.headers.get("set-cookie") ?? "";
	expect(setCookie).toContain("dsh-auth-");
	const cookie = setCookie.split(";", 1)[0] ?? "";
	return { server, driver, cookie };
}

function rpcBody(rpcId: string, method: string, args: Record<string, unknown>): string {
	return JSON.stringify({ type: "client-request", rpcId, method, payload: { args } });
}

async function postApi(
	server: WebServerHandle,
	cookie: string,
	endpoint: string,
	args: Record<string, unknown> = {},
): Promise<{ status: number; body: { result?: { ok: boolean; value?: unknown; error?: { code: string } } } }> {
	const response = await fetch(`${server.url}/api/${endpoint}`, {
		method: "POST",
		headers: { cookie, "content-type": "application/json" },
		body: rpcBody("rpc-1", endpoint, args),
	});
	return { status: response.status, body: (await response.json()) as never };
}

function emit(driver: ReturnType<typeof fakeDriver>, notification: WebStreamEvent): void {
	for (const listener of driver.state.listeners) listener(notification);
}

/** One mux client: collects frames, answers stream opens, and resolves waiters by predicate. */
class MuxClient {
	readonly frames: Array<Record<string, unknown>> = [];
	readonly #waiters: Array<{ match: (frame: Record<string, unknown>) => boolean; resolve: (frame: Record<string, unknown>) => void }> = [];
	readonly #socket: WebSocket;

	constructor(url: string, cookie: string) {
		this.#socket = new WebSocket(url, { headers: { cookie } } as never);
		this.#socket.onmessage = event => {
			const frame = JSON.parse(event.data as string) as Record<string, unknown>;
			this.frames.push(frame);
			for (let i = this.#waiters.length - 1; i >= 0; i--) {
				const waiter = this.#waiters[i];
				if (waiter !== undefined && waiter.match(frame)) {
					this.#waiters.splice(i, 1);
					waiter.resolve(frame);
				}
			}
		};
	}

	async opened(): Promise<void> {
		if (this.#socket.readyState === WebSocket.OPEN) return;
		await new Promise<void>((resolve, reject) => {
			this.#socket.onopen = () => resolve();
			this.#socket.onerror = () => reject(new Error("mux socket error"));
		});
	}

	send(frame: Record<string, unknown>): void {
		this.#socket.send(JSON.stringify(frame));
	}

	openStream(streamId: string, endpoint: string, args: Record<string, unknown> = {}): void {
		this.send({ type: "open", streamId, endpoint, payload: { args } });
	}

	waitFor(match: (frame: Record<string, unknown>) => boolean, timeoutMs = 3000): Promise<Record<string, unknown>> {
		const existing = this.frames.find(match);
		if (existing !== undefined) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("mux frame timeout")), timeoutMs);
			this.#waiters.push({
				match,
				resolve: frame => {
					clearTimeout(timer);
					resolve(frame);
				},
			});
		});
	}

	close(): void {
		this.#socket.close();
	}
}

describe("startWebServer (0.2.x surface)", () => {
	test("the index requires auth; the launch token redeems into the signed cookie", async () => {
		const { server, cookie } = await startFixtureServer();
		expect((await fetch(server.url)).status).toBe(401);
		const response = await fetch(server.url, { headers: { cookie } });
		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("window.__ModuleLoader__");
		expect(html).toMatch(
			/<script src="plugins\/\?\?@deepseek-ai\/dsh-client-modules\/client\.js&rev=[0-9a-f]{12}"><\/script>/,
		);
		expect(html).toContain('"batches"');
		const ready = html.indexOf("__DSH_BOOT_READY__");
		expect(ready).toBeGreaterThan(-1);
		expect(ready).toBeLessThan(html.indexOf("</body>"));
	});

	test("plugin bundles serve single and combo forms behind auth", async () => {
		const { server, cookie } = await startFixtureServer();
		expect((await fetch(`${server.url}/plugins/@deepseek-ai/dsh-client-ui-demo/client.js`)).status).toBe(401);
		const bundle = await fetch(`${server.url}/plugins/@deepseek-ai/dsh-client-ui-demo/client.js?rev=x`, {
			headers: { cookie },
		});
		expect(bundle.status).toBe(200);
		expect(await bundle.text()).toContain("dsh-client-ui-demo");
		const combo = await fetch(
			`${server.url}/plugins/??@deepseek-ai/dsh-client-modules/client.js,@deepseek-ai/dsh-client-ui-demo/client.js&rev=x`,
			{ headers: { cookie } },
		);
		expect(combo.status).toBe(200);
		const text = await combo.text();
		expect(text.indexOf("dsh-client-modules")).toBeLessThan(text.indexOf("dsh-client-ui-demo"));
	});

	test("unary calls route by endpoint; envelope and claim discipline hold", async () => {
		const { server, driver, cookie } = await startFixtureServer();
		const list = await postApi(server, cookie, "session/list");
		expect(list.status).toBe(200);
		expect(list.body.result).toMatchObject({ ok: true });
		const prompt = await postApi(server, cookie, "session/prompt", {
			requestId: "req-1",
			sessionId: "s1",
			mode: "queue",
			content: [{ type: "text", text: "hello" }],
		});
		expect(prompt.body.result).toEqual({ ok: true, value: { accepted: true } });
		expect(driver.state.prompts).toEqual([{ sessionId: "s1", text: "hello" }]);
		const unimplemented = await postApi(server, cookie, "terminal/list", { sessionId: "s1" });
		expect(unimplemented.body.result).toMatchObject({ ok: false, error: { code: "gateway/service-unavailable" } });
		const unclaimed = await fetch(`${server.url}/api/nope/nope`, {
			method: "POST",
			headers: { cookie, "content-type": "application/json" },
			body: rpcBody("rpc-2", "nope/nope", {}),
		});
		expect(unclaimed.status).toBe(404);
		const wrongType = await fetch(`${server.url}/api/session/list`, {
			method: "POST",
			headers: { cookie, "content-type": "text/plain" },
			body: "x",
		});
		expect(wrongType.status).toBe(415);
		const unauthenticated = await fetch(`${server.url}/api/session/list`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("rpc-3", "session/list", {}),
		});
		expect(unauthenticated.status).toBe(401);
	});

	test("GET /api/session.export serves the session log zip behind auth", async () => {
		const { server, cookie } = await startFixtureServer();
		expect((await fetch(`${server.url}/api/session.export?sessionId=s1`)).status).toBe(401);
		const response = await fetch(`${server.url}/api/session.export?sessionId=s1`, { headers: { cookie } });
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/zip");
	});

	test("the mux opens $events with the ready marker, then control baseline and follow snapshot", async () => {
		const history: Map<string, WebHistoryResult> = new Map([
			[
				"s1",
				{
					events: [
						{ type: "turn/start" as const, seq: 0, time: 10, data: { turn: 1 } },
						{ type: "turn/end" as const, seq: 1, time: 20, data: { turn: 1, reason: { kind: "completed" } } },
					],
					hasMore: false,
					title: "Fixture title",
				},
			],
		]);
		const { server, driver, cookie } = await startFixtureServer({ history });
		const mux = new MuxClient(`${server.url.replace("http", "ws")}/api/remote.mux`, cookie);
		await mux.opened();
		mux.openStream("ev", "$events");
		const ready = await mux.waitFor(frame => frame.streamId === "ev");
		expect(ready.value).toMatchObject({ type: "ready", host: { home: "/home/user" } });
		const clientId = (ready.value as { clientId: string }).clientId;
		expect(typeof clientId).toBe("string");

		mux.openStream("ctl", "session/control");
		const baseline = await mux.waitFor(frame => frame.streamId === "ctl");
		expect(baseline.value).toMatchObject({ type: "baseline" });

		mux.openStream("fol", "session/follow", {
			address: { kind: "session", sessionId: "s1" },
			assistantStream: true,
		});
		const snapshot = await mux.waitFor(frame => frame.streamId === "fol");
		expect(snapshot.value).toMatchObject({ type: "snapshot", cursor: 1, assistantStream: { revision: 0 } });

		// The next journal event streams onto the follow; a gap ends it with an error.
		emit(driver, {
			kind: "session-event",
			sessionId: "s1",
			event: { type: "turn/start", seq: 2, time: 30, data: { turn: 2 } },
		});
		const streamed = await mux.waitFor(
			frame => frame.streamId === "fol" && (frame.value as { type?: string })?.type === "event",
		);
		expect(streamed.value).toMatchObject({ event: { seq: 2 } });
		emit(driver, {
			kind: "session-event",
			sessionId: "s1",
			event: { type: "turn/start", seq: 4, time: 40, data: { turn: 3 } },
		});
		const gap = await mux.waitFor(frame => frame.streamId === "fol" && frame.type === "error");
		expect(gap.error).toMatchObject({ code: "session/event-gap" });
		mux.close();
	});

	test("an approval ask rides the $events waterfall and settles through $events/result", async () => {
		const { server, driver, cookie } = await startFixtureServer();
		const mux = new MuxClient(`${server.url.replace("http", "ws")}/api/remote.mux`, cookie);
		await mux.opened();
		mux.openStream("ev", "$events");
		const ready = await mux.waitFor(frame => frame.streamId === "ev");
		const clientId = (ready.value as { clientId: string }).clientId;

		let settled: unknown;
		emit(driver, {
			kind: "ask-requested",
			sessionId: "s1",
			rpcId: "ask-1",
			request: { kind: "approval", approval: { approvalId: "ap-1", toolName: "bash" } },
			settle: outcome => {
				settled = outcome;
			},
			fail: error => {
				throw error;
			},
		});
		const askFrame = await mux.waitFor(
			frame => (frame.value as { event?: string })?.event === "approval/request",
		);
		const eventId = (askFrame.value as { eventId: string }).eventId;
		expect(typeof eventId).toBe("string");

		const result = await postApi(server, cookie, "$events/result", {
			clientId,
			eventId,
			outcome: {
				kind: "result",
				value: { sessionId: "s1", approvalId: "ap-1", outcome: "allowed-once" },
			},
		});
		expect(result.body.result).toEqual({ ok: true, value: { accepted: true } });
		expect(settled).toEqual({ kind: "approval", outcome: "allowed-once" });
		mux.close();
	});

	test("the mux requires auth and an upgrade", async () => {
		const { server, cookie } = await startFixtureServer();
		expect((await fetch(`${server.url}/api/remote.mux`)).status).toBe(401);
		expect((await fetch(`${server.url}/api/remote.mux`, { headers: { cookie } })).status).toBe(426);
	});
});
