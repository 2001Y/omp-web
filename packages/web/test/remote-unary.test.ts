import { describe, expect, test } from "bun:test";
import { createRemoteDispatcher } from "../src/remote/unary";
import type { ClientRequest } from "../src/remote/wire";
import type { WebHistoryResult } from "../src/protocol/driver";
import { fakeDriver } from "./fake-driver";

function request(endpoint: string, args: Record<string, unknown> = {}, rpcId = "r-1"): ClientRequest {
	return { type: "client-request", rpcId, method: endpoint, payload: { args } };
}

async function dispatch(driver: ReturnType<typeof fakeDriver>, endpoint: string, args: Record<string, unknown> = {}) {
	const outcome = await createRemoteDispatcher(driver).dispatch(endpoint, request(endpoint, args));
	if (outcome.status !== 200) throw new Error(`expected 200 outcome for ${endpoint}`);
	return outcome.response;
}

function historyFixture(): Map<string, WebHistoryResult> {
	return new Map([
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
}

describe("remote unary dispatcher", () => {
	test("session/list answers rc2 summaries with agent availability and title hints", async () => {
		const driver = fakeDriver();
		const response = await dispatch(driver, "session/list");
		expect(response).toMatchObject({ type: "server-response", rpcId: "r-1" });
		const result = response.result;
		if (!result.ok) throw new Error("expected ok result");
		const value = result.value as { items: Array<Record<string, unknown>> };
		expect(value.items).toHaveLength(1);
		expect(value.items[0]).toMatchObject({ sessionId: "s1", running: false, blank: false });
	});

	test("an unknown namespace is not claimed (404); a known unimplemented one answers service-unavailable", async () => {
		const driver = fakeDriver();
		const dispatcher = createRemoteDispatcher(driver);
		expect(await dispatcher.dispatch("nope/nope", request("nope/nope"))).toEqual({ status: 404 });
		const outcome = await dispatcher.dispatch("terminal/list", request("terminal/list", { sessionId: "s1" }));
		if (outcome.status !== 200) throw new Error("expected 200 outcome");
		expect(outcome.response.result).toMatchObject({ ok: false, error: { code: "gateway/service-unavailable" } });
	});

	test("an unimplemented session method answers method-unavailable, not the generic internal error", async () => {
		const driver = fakeDriver();
		const response = await dispatch(driver, "session/openWorkspacePath", { path: "/tmp" });
		expect(response.result).toMatchObject({ ok: false, error: { code: "gateway/method-unavailable" } });
	});

	test("the payload must be exactly one args object, and method must match the endpoint", async () => {
		const driver = fakeDriver();
		const dispatcher = createRemoteDispatcher(driver);
		const badPayload = await dispatcher.dispatch("session/list", {
			type: "client-request",
			rpcId: "r-2",
			method: "session/list",
			payload: { args: {}, extra: 1 } as never,
		});
		if (badPayload.status !== 200) throw new Error("expected 200 outcome");
		expect(badPayload.response.result).toMatchObject({ ok: false, error: { code: "gateway/bad-request" } });
		const mismatched = await dispatcher.dispatch("session/list", request("session/create"));
		if (mismatched.status !== 200) throw new Error("expected 200 outcome");
		expect(mismatched.response.result).toMatchObject({ ok: false, error: { code: "gateway/bad-request" } });
	});

	test("session/prompt validates parts and reaches the driver; file parts are rejected for now", async () => {
		const driver = fakeDriver();
		const response = await dispatch(driver, "session/prompt", {
			requestId: "req-1",
			sessionId: "s1",
			mode: "queue",
			content: [{ type: "text", text: "hello" }],
		});
		expect(response.result).toEqual({ ok: true, value: { accepted: true } });
		expect(driver.state.prompts).toEqual([{ sessionId: "s1", text: "hello" }]);
		const fileResponse = await dispatch(driver, "session/prompt", {
			requestId: "req-2",
			sessionId: "s1",
			mode: "queue",
			content: [{ type: "file", receiptId: "rcpt-1" }],
		});
		expect(fileResponse.result).toMatchObject({ ok: false, error: { code: "gateway/arguments-invalid" } });
	});

	test("session/page wraps journal events as records at or below throughSeq", async () => {
		const driver = fakeDriver({ history: historyFixture() });
		const response = await dispatch(driver, "session/page", {
			address: { kind: "session", sessionId: "s1" },
			throughSeq: 0,
		});
		if (!response.result.ok) throw new Error("expected ok result");
		const value = response.result.value as { records: Array<{ type: string; event: { seq: number } }>; hasMore: boolean };
		expect(value.records).toHaveLength(1);
		expect(value.records[0]).toMatchObject({ type: "event", event: { seq: 0 } });
	});

	test("session/projections answers a sequenced baseline seeded from history", async () => {
		const driver = fakeDriver({ history: historyFixture() });
		const response = await dispatch(driver, "session/projections", { sessionId: "s1" });
		if (!response.result.ok) throw new Error("expected ok result");
		const value = response.result.value as { kind: string; asOfSeq: number; values: Record<string, unknown> };
		expect(value.kind).toBe("sequenced");
		expect(value.asOfSeq).toBe(1);
		expect(value.values.title).toBe("Fixture title");
		expect(value.values.modelSelection).toMatchObject({ next: { provider: "p", model: "m" } });
	});

	test("the follow snapshot carries header, cursor, records and the assistant-stream baseline", async () => {
		const driver = fakeDriver({ history: historyFixture() });
		const snapshot = await createRemoteDispatcher(driver).followSnapshot(driver, "s1", { assistantStream: true });
		expect(snapshot.type).toBe("snapshot");
		expect(snapshot.cursor).toBe(1);
		expect(snapshot.header).toMatchObject({ id: "s1", cwd: "/tmp/project", isSeeded: false });
		expect(snapshot.records).toHaveLength(2);
		expect(snapshot.projections).toMatchObject({ asOfSeq: 1, values: { title: "Fixture title" } });
		expect(snapshot.assistantStream).toEqual({ revision: 0 });
	});

	test("session/modelCatalog answers the host catalog from the attached session's model face", async () => {
		const driver = fakeDriver({ attached: [{ sessionId: "s1", lastSeq: 1 }] });
		const response = await dispatch(driver, "session/modelCatalog");
		if (!response.result.ok) throw new Error("expected ok result");
		const value = response.result.value as { default: unknown; routableProviders: string[]; failures: unknown[] };
		expect(value.routableProviders).toEqual(["p"]);
		expect(value.failures).toEqual([]);
	});

	test("workspace/create unwraps the request object and answers the adopted workspace", async () => {
		const driver = fakeDriver();
		const response = await dispatch(driver, "workspace/create", { request: { path: "/work" } });
		if (!response.result.ok) throw new Error("expected ok result");
		const value = response.result.value as { workspace: { workspaceId: string; title: string }; created: boolean };
		expect(value.created).toBe(true);
		expect(value.workspace.workspaceId).toBe("/work");
		expect(value.workspace.title).toBe("work");
	});

	test("workspace/create without a request path is an arguments error, not a driver call", async () => {
		const driver = fakeDriver();
		const response = await dispatch(driver, "workspace/create", { request: {} });
		expect(response.result).toMatchObject({ ok: false, error: { code: "gateway/arguments-invalid" } });
	});

	test("directoryPicker/list answers the listing shape the browser dialog renders", async () => {
		const driver = fakeDriver();
		const response = await dispatch(driver, "directoryPicker/list", { path: "/home/user/docs" });
		if (!response.result.ok) throw new Error("expected ok result");
		const value = response.result.value as { path: string; home: string; entries: unknown[]; truncated: boolean };
		expect(value.path).toBe("/home/user/docs");
		expect(value.home).toBe("/home/user");
		expect(value.entries).toEqual([]);
		expect(value.truncated).toBe(false);
	});

	test("directoryPicker/createDirectory answers the created path as a bare string", async () => {
		const driver = fakeDriver();
		const response = await dispatch(driver, "directoryPicker/createDirectory", { path: "/parent", name: "child" });
		if (!response.result.ok) throw new Error("expected ok result");
		expect(response.result.value).toBe("/parent/child");
	});

	test("directoryPicker/pick answers method-unavailable (no OS chooser behind a browser)", async () => {
		const driver = fakeDriver();
		const response = await dispatch(driver, "directoryPicker/pick");
		expect(response.result).toMatchObject({ ok: false, error: { code: "gateway/method-unavailable" } });
	});
});
