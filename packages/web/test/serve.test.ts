import { afterEach, describe, expect, test } from "bun:test";
import { startWebServer, type WebServerHandle } from "../src/server/serve";
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
): Promise<{ server: WebServerHandle; driver: ReturnType<typeof fakeDriver> }> {
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
	const server = await startWebServer({ driver, dshRoot: tree.root, port: 0, roster });
	SERVERS.push(server);
	return { server, driver };
}

function rpcBody(rpcId: string, method: string, payload: unknown): string {
	return JSON.stringify({ type: "client-request", rpcId, method, payload });
}

/** Collect text frames from one downlink WebSocket until the wanted count or timeout. */
function collectFrames(url: string, count: number, timeoutMs: number): Promise<unknown[]> {
	return collectFramesObservable(url, count, timeoutMs).frames;
}

/**
 * Frame collector with an awaitable open signal: the server publishes only to
 * connected sockets, so tests must emit strictly after the handshake.
 */
function collectFramesObservable(
	url: string,
	count: number,
	timeoutMs: number,
): { frames: Promise<unknown[]>; opened: Promise<void> } {
	let openedResolve: () => void;
	const opened = new Promise<void>(resolve => {
		openedResolve = resolve;
	});
	const frames = new Promise<unknown[]>((resolve, reject) => {
		const collected: unknown[] = [];
		const socket = new WebSocket(url);
		const timer = setTimeout(() => {
			socket.close();
			reject(new Error(`collected only ${String(collected.length)} of ${String(count)} frames`));
		}, timeoutMs);
		socket.onopen = () => openedResolve();
		socket.onmessage = event => {
			collected.push(JSON.parse(event.data as string));
			if (collected.length >= count) {
				clearTimeout(timer);
				socket.close();
				resolve(collected);
			}
		};
		socket.onerror = () => {
			clearTimeout(timer);
			reject(new Error("websocket error"));
		};
	});
	return { frames, opened };
}

describe("startWebServer", () => {
	test("the index carries the boot protocol: queue facade, both preloads, and the graph global", async () => {
		const { server } = await startFixtureServer();
		const response = await fetch(server.url);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const html = await response.text();
		expect(html).toContain("window.__ModuleLoader__");
		expect(html).toMatch(
			/<script src="\/plugins\/@deepseek-ai\/dsh-client-modules\/client.js\?rev=[0-9a-f]{12}"><\/script>/,
		);
		expect(html).toMatch(
			/<script src="\/plugins\/@deepseek-ai\/dsh-client-runtime\/client.js\?rev=[0-9a-f]{12}"><\/script>/,
		);
		expect(html).toContain('globalThis["__DSH_BOOT__"]');
	});

	test("dist assets serve with their mime type; missing paths 404", async () => {
		const { server } = await startFixtureServer();
		const asset = await fetch(`${server.url}/assets/index-fixture.js`);
		expect(asset.status).toBe(200);
		expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(await fetch(`${server.url}/assets/absent.css`)).toHaveProperty("status", 404);
	});

	test("plugin bundles and their maps serve from the composed table", async () => {
		const { server } = await startFixtureServer();
		const bundle = await fetch(`${server.url}/plugins/@deepseek-ai/dsh-client-ui-demo/client.js?rev=x`);
		expect(bundle.status).toBe(200);
		expect(bundle.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(await bundle.text()).toContain("dsh-client-ui-demo");
		const map = await fetch(`${server.url}/plugins/@deepseek-ai/dsh-client-ui-demo/client.js.map`);
		expect(map.status).toBe(200);
		expect(await fetch(`${server.url}/plugins/@deepseek-ai/unknown/client.js`)).toHaveProperty("status", 404);
	});

	test("session.list carries the title through the projections block; fileReferences/list dispatches", async () => {
		const { server, driver } = await startFixtureServer({
			sessions: [
				{ sessionId: "s1", updatedAt: 1, running: false, blank: false, cwd: "/tmp/project", title: "会话标题" },
			],
		});
		const list = await fetch(`${server.url}/api/session.list`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("t-1", "session.list", {}),
		});
		const value = ((await list.json()) as { result: { value: { items: unknown[] } } }).result.value;
		expect(value.items[0]).toMatchObject({
			sessionId: "s1",
			projections: { asOfSeq: 0, values: { title: "会话标题" } },
		});
		const patched = driver as unknown as {
			listFileReferences: (sessionId: string, query: string) => Promise<unknown[]>;
		};
		patched.listFileReferences = async (_sessionId, query) => [{ path: query, kind: "file" }];
		const refs = await fetch(`${server.url}/api/fileReferences/list`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("t-2", "fileReferences/list", { args: { agentId: "s1", query: "pack" } }),
		});
		expect(((await refs.json()) as { result: { ok: boolean; value: unknown[] } }).result).toEqual({
			ok: true,
			value: [{ path: "pack", kind: "file" }],
		});
	});

	test("POST /api/host.describe echoes the request rpcId with the driver snapshot", async () => {
		const { server } = await startFixtureServer();
		const response = await fetch(`${server.url}/api/host.describe`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("rpc-1", "host.describe", {}),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			type: "server-response",
			rpcId: "rpc-1",
			result: {
				ok: true,
				value: {
					version: "18.0.4-test",
					cwd: "/tmp/project",
					home: "/home/user",
					attachedSessions: 1,
					canOpenPath: false,
				},
			},
		});
	});

	test("settings.describe serves the document facts and openDocument reaches the driver", async () => {
		const { server, driver } = await startFixtureServer();
		const describe = await fetch(`${server.url}/api/settings.describe`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("s-1", "settings.describe", {}),
		});
		expect(((await describe.json()) as { result: { ok: boolean; value: unknown } }).result).toEqual({
			ok: true,
			value: { writable: false, hasDocument: true, namespaces: [] },
		});
		const open = await fetch(`${server.url}/api/settings.openDocument`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("s-2", "settings.openDocument", {}),
		});
		expect(((await open.json()) as { result: { ok: boolean; value: unknown } }).result).toEqual({
			ok: true,
			value: { opened: true },
		});
		expect(driver.state.documentOpens).toEqual([true]);
	});

	test("subagent.list shapes the catalog rows over the driver entries", async () => {
		const { server, driver } = await startFixtureServer();
		const patched = driver as unknown as {
			listSubagents: (parent: string) => Promise<{
				entries: Array<{
					id: string;
					mode: "one-shot" | "continuable";
					activity: "running" | "inactive";
					hasChildren: boolean;
					label?: string;
				}>;
				parentAvailable: boolean;
			}>;
		};
		patched.listSubagents = async () => ({
			entries: [
				{ id: "child-1", mode: "continuable", activity: "running", hasChildren: false, label: "Researcher" },
			],
			parentAvailable: true,
		});
		const response = await fetch(`${server.url}/api/subagent.list`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("sub-1", "subagent.list", { parentSessionId: "s1" }),
		});
		expect(((await response.json()) as { result: { ok: boolean; value: unknown } }).result).toEqual({
			ok: true,
			value: {
				parentAvailable: true,
				entries: [
					{
						kind: "child",
						id: "child-1",
						activity: "running",
						hasChildren: false,
						mode: "continuable",
						label: "Researcher",
					},
				],
			},
		});
	});

	test("a commands-changed notification broadcasts the commands/change signal on mux", async () => {
		const { server, driver } = await startFixtureServer();
		// No attached sessions in this fixture: the signal is the only frame.
		const collected = collectFrames(`${server.url.replace("http", "ws")}/api/events.mux`, 1, 5000);
		await Bun.sleep(100);
		for (const listener of driver.state.listeners) {
			listener({ kind: "commands-changed" });
		}
		const [frame] = (await collected) as Array<{ method: string; payload: unknown }>;
		expect(frame).toMatchObject({ method: "commands/change", payload: {} });
	});

	test("cancel-asks settles a parked approval and broadcasts its rejected resolution", async () => {
		const { server, driver } = await startFixtureServer();
		const collected = collectFramesObservable(`${server.url.replace("http", "ws")}/api/events.mux`, 2, 5000);
		await collected.opened;
		let failResolve: (message: string) => void = () => {};
		const failed = new Promise<string>(resolve => {
			failResolve = resolve;
		});
		let settled: string | undefined;
		for (const listener of driver.state.listeners) {
			listener({
				kind: "ask-requested",
				sessionId: "s1",
				rpcId: "ask-x",
				request: {
					kind: "approval",
					approval: { approvalId: "ap-x", toolName: "write", reason: "Allow tool: write" },
				},
				settle: outcome => {
					settled = outcome.kind === "approval" ? outcome.outcome : "wrong-kind";
				},
				fail: error => failResolve(error.message),
			});
		}
		// The turn unwinds (abort/rewind/switch): the parked gate promise must
		// settle and the client panel must drop via the resolved counterpart.
		for (const listener of driver.state.listeners) {
			listener({ kind: "cancel-asks", sessionId: "s1", reason: "omp-web: turn aborted" });
		}
		expect(await failed).toBe("omp-web: turn aborted");
		expect(settled).toBeUndefined();
		const seen = (await collected.frames) as Array<{ method: string; payload: Record<string, unknown> }>;
		expect(seen[0]).toMatchObject({ method: "approval/requested" });
		expect(seen[1]).toMatchObject({
			method: "approval/resolved",
			payload: { type: "approval/resolved", sessionId: "s1", approvalId: "ap-x", outcome: "rejected" },
		});
		// The ask is gone: a late client answer answers not-pending.
		const stale = await fetch(`${server.url}/api/respond`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "client-response",
				rpcId: "ask-x",
				result: { ok: true, value: { sessionId: "s1", approvalId: "ap-x", outcome: "allowed-once" } },
			}),
		});
		expect(await stale.json()).toEqual({ accepted: false, reason: "not-pending" });
	});

	test("cancel-asks settles a parked question with the cancelled resolution", async () => {
		const { server, driver } = await startFixtureServer();
		const collected = collectFramesObservable(`${server.url.replace("http", "ws")}/api/events.mux`, 2, 5000);
		await collected.opened;
		let failResolve: (message: string) => void = () => {};
		const failed = new Promise<string>(resolve => {
			failResolve = resolve;
		});
		for (const listener of driver.state.listeners) {
			listener({
				kind: "ask-requested",
				sessionId: "s1",
				rpcId: "ask-q",
				request: {
					kind: "question",
					questions: [{ id: "q-1", question: "pick", options: [{ label: "a" }, { label: "b" }] }],
				},
				settle: () => {},
				fail: error => failResolve(error.message),
			});
			listener({ kind: "cancel-asks", sessionId: "s1", reason: "omp-web: session switched" });
		}
		expect(await failed).toBe("omp-web: session switched");
		const seen = (await collected.frames) as Array<{ method: string; payload: Record<string, unknown> }>;
		expect(seen[0]).toMatchObject({ method: "question/requested" });
		expect(seen[1]).toMatchObject({
			method: "question/resolved",
			payload: { type: "question/resolved", sessionId: "s1", questionRpcId: "ask-q", outcome: "cancelled" },
		});
	});

	test("session-attached broadcasts the subscribed re-baseline with the queue snapshot", async () => {
		const { server, driver } = await startFixtureServer();
		const collected = collectFramesObservable(`${server.url.replace("http", "ws")}/api/events.mux`, 2, 5000);
		await collected.opened;
		const queueItem = {
			id: "q9",
			placement: "queued" as const,
			message: {
				id: "m9",
				role: "user" as const,
				content: [{ type: "text" as const, text: "held" }],
				source: { kind: "user" as const },
			},
		};
		for (const listener of driver.state.listeners) {
			listener({ kind: "session-attached", sessionId: "s2", lastSeq: 12, queue: [queueItem] });
		}
		const seen = (await collected.frames) as Array<{ method: string; payload: Record<string, unknown> }>;
		expect(seen[0]).toMatchObject({
			method: "session/subscribed",
			payload: { type: "session/subscribed", sessionId: "s2", lastSeq: 12 },
		});
		expect(seen[1]).toMatchObject({
			method: "session/queue",
			payload: { type: "session/queue", sessionId: "s2", items: [queueItem] },
		});
	});

	test("GET /api/session.export serves the session log zip; HEAD probes; unknown ids 404", async () => {
		const { server } = await startFixtureServer();
		const head = await fetch(`${server.url}/api/session.export?sessionId=s1&includeDescendants=true`, {
			method: "HEAD",
		});
		expect(head.status).toBe(200);
		expect(head.headers.get("content-type")).toBe("application/zip");
		expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);

		const get = await fetch(`${server.url}/api/session.export?sessionId=s1`, { method: "GET" });
		expect(get.status).toBe(200);
		expect(get.headers.get("content-disposition")).toContain("omp-session-s1-logs.zip");
		const body = new Uint8Array(await get.arrayBuffer());
		// PK\x03\x04 local header magic, the entry name, and the stored payload.
		expect([...body.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
		const text = new TextDecoder().decode(body);
		expect(text).toContain("s1.jsonl");
		expect(text).toContain('{"type":"session"}');

		const missing = await fetch(`${server.url}/api/session.export?sessionId=ghost`, { method: "GET" });
		expect(missing.status).toBe(404);
		const post = await fetch(`${server.url}/api/session.export?sessionId=s1`, { method: "POST" });
		expect(post.status).toBe(405);
		const noId = await fetch(`${server.url}/api/session.export`, { method: "GET" });
		expect(noId.status).toBe(400);
	});

	test("an unimplemented method answers the envelope with the internal error", async () => {
		const { server } = await startFixtureServer();
		const response = await fetch(`${server.url}/api/session.fork`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("rpc-2", "session.fork", {}),
		});
		const envelope = (await response.json()) as { result: { ok: boolean; error: { code: string } } };
		expect(envelope.result.ok).toBe(false);
		expect(envelope.result.error.code).toBe("internal");
	});

	test("POST /api/respond yields the not-pending receipt; a malformed body yields bad-response", async () => {
		const { server } = await startFixtureServer();
		const respond = async (body: string): Promise<unknown> =>
			(
				await fetch(`${server.url}/api/respond`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				})
			).json();
		expect(
			await respond(JSON.stringify({ type: "client-response", rpcId: "r", result: { ok: true, value: 1 } })),
		).toEqual({ accepted: false, reason: "not-pending" });
		expect(await respond(JSON.stringify({ type: "client-request", rpcId: "r" }))).toEqual({
			accepted: false,
			reason: "bad-response",
		});
	});

	test("GET on a downlink path without an Upgrade header answers 426 asking for websocket", async () => {
		const { server } = await startFixtureServer();
		const response = await fetch(`${server.url}/api/events.mux`);
		expect(response.status).toBe(426);
		expect(response.headers.get("upgrade")).toBe("websocket");
	});

	test("the mux downlink opens with the subscribed baseline, then streams session events", async () => {
		const { server, driver } = await startFixtureServer({ attached: [{ sessionId: "s1", lastSeq: 41 }] });
		const collected = collectFrames(`${server.url.replace("http", "ws")}/api/events.mux`, 2, 5000);
		await Bun.sleep(100);
		for (const listener of driver.state.listeners) {
			listener({
				kind: "session-event",
				sessionId: "s1",
				event: { type: "turn/start", seq: 42, time: 5, data: { turn: 0 } },
			});
		}
		const frames = (await collected) as Array<{ type: string; rpcId: string; method: string; payload: unknown }>;
		expect(frames[0]).toMatchObject({
			type: "server-request",
			method: "session/subscribed",
			payload: { type: "session/subscribed", sessionId: "s1", lastSeq: 41 },
		});
		expect(frames[1]).toMatchObject({
			type: "server-request",
			method: "session/event",
			payload: {
				type: "session/event",
				sessionId: "s1",
				event: { type: "turn/start", seq: 42, time: 5, data: { turn: 0 } },
			},
		});
		expect(typeof frames[0].rpcId).toBe("string");
	});

	test("the mux baseline carries the queue snapshot after subscribed, and queue flips stream", async () => {
		const queueItem = {
			id: "q1",
			placement: "steering" as const,
			message: {
				id: "m1",
				role: "user" as const,
				content: [{ type: "text" as const, text: "steer this" }],
				source: { kind: "user" as const },
			},
		};
		const { server, driver } = await startFixtureServer({
			attached: [{ sessionId: "s1", lastSeq: 7 }],
			queues: new Map([["s1", [queueItem]]]),
		});
		const baseline = collectFrames(`${server.url.replace("http", "ws")}/api/events.mux`, 2, 5000);
		const baseFrames = (await baseline) as Array<{ method: string; payload: Record<string, unknown> }>;
		expect(baseFrames[0]).toMatchObject({ method: "session/subscribed" });
		expect(baseFrames[1]).toMatchObject({
			method: "session/queue",
			payload: { type: "session/queue", sessionId: "s1", items: [queueItem] },
		});
		// A live queue flip rides the same mux channel (the fresh connection's
		// first frame is its own subscribed baseline).
		const flip = collectFrames(`${server.url.replace("http", "ws")}/api/events.mux`, 3, 5000);
		await Bun.sleep(100);
		for (const listener of driver.state.listeners) {
			listener({ kind: "session-queue", sessionId: "s1", items: [] });
		}
		const flipFrames = (await flip) as Array<{ method: string; payload: Record<string, unknown> }>;
		expect(flipFrames.at(-1)).toMatchObject({
			method: "session/queue",
			payload: { type: "session/queue", sessionId: "s1", items: [] },
		});
	});

	test("session.updateQueue reaches the driver; a malformed action folds into the internal error", async () => {
		const { server, driver } = await startFixtureServer();
		const ok = await fetch(`${server.url}/api/session.updateQueue`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("q-1", "session.updateQueue", {
				sessionId: "s1",
				itemId: "q1",
				action: { kind: "steer" },
			}),
		});
		expect(((await ok.json()) as { result: { ok: boolean; value: unknown } }).result).toEqual({
			ok: true,
			value: { accepted: true },
		});
		expect(driver.state.queueUpdates).toEqual([{ sessionId: "s1", itemId: "q1", action: { kind: "steer" } }]);
		const edit = await fetch(`${server.url}/api/session.updateQueue`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("q-2", "session.updateQueue", {
				sessionId: "s1",
				itemId: "q1",
				action: { kind: "edit", content: [{ type: "text", text: "new text" }] },
			}),
		});
		expect(((await edit.json()) as { result: { ok: boolean } }).result.ok).toBe(true);
		expect(driver.state.queueUpdates.at(-1)?.action).toEqual({
			kind: "edit",
			content: [{ type: "text", text: "new text" }],
		});
		const bad = await fetch(`${server.url}/api/session.updateQueue`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: rpcBody("q-3", "session.updateQueue", {
				sessionId: "s1",
				itemId: "q1",
				action: { kind: "teleport" },
			}),
		});
		expect(((await bad.json()) as { result: { ok: boolean } }).result.ok).toBe(false);
	});

	test("the host downlink carries session-added and status flips", async () => {
		const { server, driver } = await startFixtureServer();
		const collected = collectFrames(`${server.url.replace("http", "ws")}/api/events.host`, 2, 5000);
		await Bun.sleep(100);
		for (const listener of driver.state.listeners) {
			listener({ kind: "session-added", sessionId: "s9", blank: true, cwd: "/tmp/project" });
			listener({ kind: "session-status", sessionId: "s9", running: true });
		}
		const frames = (await collected) as Array<{ method: string; payload: Record<string, unknown> }>;
		expect(frames[0]).toMatchObject({
			method: "host/session-added",
			payload: { type: "host/session-added", sessionId: "s9", blank: true, cwd: "/tmp/project" },
		});
		expect(frames[1]).toMatchObject({
			method: "host/session-status",
			payload: { type: "host/session-status", sessionId: "s9", running: true },
		});
	});

	test("an approval ask parks, answers through /api/respond, and broadcasts both frames", async () => {
		const { server, driver } = await startFixtureServer();
		const frames = collectFrames(`${server.url.replace("http", "ws")}/api/events.mux`, 2, 5000);
		await Bun.sleep(100);
		let settled: string | undefined;
		for (const listener of driver.state.listeners) {
			listener({
				kind: "ask-requested",
				sessionId: "s1",
				rpcId: "ask-1",
				request: {
					kind: "approval",
					approval: { approvalId: "ap-1", toolName: "bash", reason: "Allow tool: bash" },
				},
				settle: outcome => {
					settled = outcome.kind === "approval" ? outcome.outcome : "wrong-kind";
				},
				fail: error => {
					settled = `failed:${error.message}`;
				},
			});
		}
		const respond = await fetch(`${server.url}/api/respond`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "client-response",
				rpcId: "ask-1",
				result: { ok: true, value: { sessionId: "s1", approvalId: "ap-1", outcome: "allowed-once" } },
			}),
		});
		expect(await respond.json()).toEqual({ accepted: true });
		await Bun.sleep(200);
		expect(settled).toBe("allowed-once");
		const seen = (await frames) as Array<{ rpcId: string; method: string; payload: Record<string, unknown> }>;
		// The envelope id must equal the ask id: the client's respond echoes the
		// envelope rpcId back to /api/respond, which maps it onto the parked ask.
		expect(seen[0].rpcId).toBe("ask-1");
		expect(seen[0]).toMatchObject({
			method: "approval/requested",
			payload: { type: "approval/requested", sessionId: "s1", approvalId: "ap-1", toolName: "bash" },
		});
		expect(seen[1]).toMatchObject({
			method: "approval/resolved",
			payload: { type: "approval/resolved", sessionId: "s1", approvalId: "ap-1", outcome: "allowed-once" },
		});
		// A second respond for the settled rpcId answers not-pending.
		const stale = await fetch(`${server.url}/api/respond`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "client-response",
				rpcId: "ask-1",
				result: { ok: true, value: { sessionId: "s1", approvalId: "ap-1", outcome: "rejected" } },
			}),
		});
		expect(await stale.json()).toEqual({ accepted: false, reason: "not-pending" });
	});

	test("a missing dsh-web dist fails startup naming the path", async () => {
		const tree = await buildFixtureTree([]);
		TREES.push(tree);
		const fs = await import("node:fs/promises");
		await fs.rm(tree.distIndex);
		await expect(
			startWebServer({
				driver: fakeDriver(),
				dshRoot: tree.root,
				port: 0,
				roster: ["@deepseek-ai/dsh-client-modules"],
			}),
		).rejects.toThrow(/frontend dist not found/);
	});
});
