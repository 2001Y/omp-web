import { describe, expect, test } from "bun:test";
import { createRpcDispatcher } from "../src/server/rpc";
import { type FakeDriverState, fakeDriver } from "./fake-driver";

describe("createRpcDispatcher", () => {
	test("host.describe returns the driver snapshot with optional fields only when set", async () => {
		const dispatch = createRpcDispatcher(
			fakeDriver({ host: { ...fakeDriver().state.host, provider: "p", model: "m" } }),
		);
		const result = await dispatch("host.describe", {});
		expect(result).toEqual({
			ok: true,
			value: {
				version: "18.0.4-test",
				cwd: "/tmp/project",
				home: "/home/user",
				provider: "p",
				model: "m",
				attachedSessions: 1,
				canOpenPath: false,
			},
		});
		const bare = await createRpcDispatcher(fakeDriver())("host.describe", {});
		expect(bare.ok && bare.value).not.toHaveProperty("provider");
	});

	test("session.list maps every driver summary onto the wire vocabulary", async () => {
		const dispatch = createRpcDispatcher(
			fakeDriver({
				sessions: [
					{
						sessionId: "s1",
						updatedAt: 1234,
						running: false,
						blank: false,
						cwd: "/tmp/project",
						parentSessionId: "s0",
						origin: "subagent",
					},
				],
			}),
		);
		const result = await dispatch("session.list", {});
		expect(result).toEqual({
			ok: true,
			value: {
				items: [
					{
						sessionId: "s1",
						updatedAt: 1234,
						running: false,
						blank: false,
						cwd: "/tmp/project",
						parentSessionId: "s0",
						origin: "subagent",
					},
				],
			},
		});
	});

	test("workspace.list serves the storage-bucket workspaces verbatim plus the archive set", async () => {
		const dispatch = createRpcDispatcher(
			fakeDriver({
				workspaces: [
					{ workspaceId: "/tmp/a", path: "/tmp/a", title: "a", sessionIds: ["s1", "s2"], updatedAt: 2 },
					{ workspaceId: "/tmp/b", path: "/tmp/b", title: "b", sessionIds: [], updatedAt: 1 },
				],
			}),
		);
		const result = await dispatch("workspace.list", {});
		const value = (result.ok && result.value) as {
			items: Array<Record<string, unknown>>;
			archivedSessionIds: string[];
		};
		expect(value.items.map(item => [item.workspaceId, item.sessionIds])).toEqual([
			["/tmp/a", ["s1", "s2"]],
			["/tmp/b", []],
		]);
		expect(value.archivedSessionIds).toEqual([]);
		for (const item of value.items) {
			expect(typeof item.createdAt).toBe("string");
			expect(typeof item.updatedAt).toBe("string");
		}
	});

	test("session.create passes the workspace through and returns the id", async () => {
		const driver = fakeDriver();
		const result = await createRpcDispatcher(driver)("session.create", { workspaceId: "/tmp/project" });
		expect(result).toEqual({ ok: true, value: { sessionId: "s-new" } });
		expect(driver.state.created).toEqual([{ workspaceId: "/tmp/project" }]);
	});

	test("session.history tail page wraps events and seeds the title projection; load-older omits it", async () => {
		const state: Partial<FakeDriverState> = {
			history: new Map([
				[
					"s1",
					{
						events: [
							{ type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
							{
								type: "user/message",
								seq: 1,
								time: 2,
								surfaceOp: "append",
								data: { id: "m", role: "user", content: [], source: { kind: "user" } },
							},
						],
						hasMore: false,
						title: "标题",
					},
				],
			]),
		};
		const dispatch = createRpcDispatcher(fakeDriver(state));
		const tail = await dispatch("session.history", { sessionId: "s1" });
		expect(tail).toEqual({
			ok: true,
			value: {
				events: [
					{ event: { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } } },
					{
						event: {
							type: "user/message",
							seq: 1,
							time: 2,
							surfaceOp: "append",
							data: { id: "m", role: "user", content: [], source: { kind: "user" } },
						},
					},
				],
				hasMore: false,
				projections: { asOfSeq: 1, values: { title: "标题" } },
			},
		});
		const older = await dispatch("session.history", { sessionId: "s1", beforeSeq: 1 });
		const value = (older.ok && older.value) as { events: unknown[]; projections?: unknown };
		expect(value.events).toHaveLength(1);
		expect(value.projections).toBeUndefined();
	});

	test("session.prompt threads the text parts into the driver", async () => {
		const driver = fakeDriver();
		const result = await createRpcDispatcher(driver)("session.prompt", {
			sessionId: "s1",
			mode: "queue",
			content: [
				{ type: "text", text: "你好" },
				{ type: "image", mediaType: "image/png", data: "" },
				{ type: "text", text: "第二行" },
			],
		});
		expect(result).toEqual({ ok: true, value: { accepted: true } });
		expect(driver.state.prompts).toEqual([{ sessionId: "s1", text: "你好\n第二行" }]);
	});

	test("session.cancel and session.rename reach the driver; missing ids fail loudly", async () => {
		const driver = fakeDriver();
		const dispatch = createRpcDispatcher(driver);
		expect(await dispatch("session.cancel", { sessionId: "s1" })).toEqual({ ok: true, value: { accepted: true } });
		expect(await dispatch("session.rename", { sessionId: "s1", title: "新名字" })).toEqual({
			ok: true,
			value: { title: "新名字", seq: 99 },
		});
		expect(driver.state.cancels).toEqual(["s1"]);
		expect(driver.state.renames).toEqual([{ sessionId: "s1", title: "新名字" }]);
		const missing = await dispatch("session.prompt", { content: [] });
		expect(missing.ok).toBe(false);
		expect(!missing.ok && missing.error.code).toBe("internal");
	});

	test("skill.list serves the session's skill catalog in the dsh shape", async () => {
		const driver = fakeDriver({
			skills: [
				{ name: "skill:review", description: "Review code", modelInvocable: true },
				{ name: "skill:deploy", description: "Ship it", modelInvocable: false },
			],
		});
		const result = await createRpcDispatcher(driver)("skill.list", { sessionId: "s1" });
		expect(result).toEqual({
			ok: true,
			value: {
				skills: [
					{ name: "skill:review", description: "Review code", modelInvocable: true },
					{ name: "skill:deploy", description: "Ship it", modelInvocable: false },
				],
			},
		});
		const missing = await createRpcDispatcher(fakeDriver())("skill.list", {});
		expect(missing.ok).toBe(false);
		expect(!missing.ok && missing.error.code).toBe("internal");
	});

	test("an unimplemented rpc-map method folds into the internal error, not a transport break", async () => {
		const result = await createRpcDispatcher(fakeDriver())("session.renameAndPrime", {});
		expect(result).toEqual({
			ok: false,
			error: {
				code: "internal",
				message: 'omp-web: method "session.renameAndPrime" is not implemented yet',
				details: {},
			},
		});
	});

	test("a generated Remote endpoint (namespace/method spelling) folds the same way", async () => {
		const result = await createRpcDispatcher(fakeDriver())("commands/directory", { args: {} });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.code).toBe("internal");
	});

	test("a driver throw becomes the internal error with the message preserved", async () => {
		const dispatch = createRpcDispatcher(fakeDriver({ history: new Map() }));
		const result = await dispatch("session.history", { sessionId: "boom" });
		expect(result).toEqual({ ok: false, error: { code: "internal", message: "no history for boom", details: {} } });
	});
	test("ompHistory tree/navigate/label serve the TUI-parity tree contract", async () => {
		const fake = fakeDriver();
		const dispatch = createRpcDispatcher(fake);
		const tree = await dispatch("ompHistory/tree", { sessionId: "s1" });
		expect(tree).toEqual({
			ok: true,
			value: {
				nodes: [
					{
						id: "e1",
						parentId: null,
						kind: "user",
						text: "hello",
						timestamp: 1,
						onCurrentPath: true,
						currentLeaf: true,
						bookkeeping: false,
						toolCallsOnly: false,
						errorOrAborted: false,
					},
				],
				branchSummariesEnabled: true,
			},
		});
		const missing = await dispatch("ompHistory/tree", {});
		expect(missing.ok).toBe(false);

		await dispatch("ompHistory/navigate", { sessionId: "s1", entryId: "e1" });
		await dispatch("ompHistory/navigate", {
			sessionId: "s1",
			entryId: "e1",
			summarize: true,
			customInstructions: "focus on tests",
		});
		expect(fake.state.navigations).toEqual([
			{ sessionId: "s1", entryId: "e1", options: {} },
			{ sessionId: "s1", entryId: "e1", options: { summarize: true, customInstructions: "focus on tests" } },
		]);

		const labeled = await dispatch("ompHistory/label", { sessionId: "s1", entryId: "e1", label: "checkpoint" });
		expect(labeled).toEqual({ ok: true, value: null });
		expect(fake.state.labels).toEqual([{ sessionId: "s1", entryId: "e1" }]);
	});

	test("session.search validates the query and maps the driver result", async () => {
		const dispatch = createRpcDispatcher(fakeDriver());
		const missing = await dispatch("session.search", {});
		expect(missing.ok).toBe(false);
		const blank = await dispatch("session.search", { query: "   " });
		expect(blank.ok).toBe(false);
		const result = await dispatch("session.search", { query: "hello" });
		expect(result).toEqual({ ok: true, value: { items: [], hasMore: false } });
	});

	test("session.attachment folds an unknown attachment into not-found", async () => {
		const dispatch = createRpcDispatcher(fakeDriver());
		const result = await dispatch("session.attachment", { sessionId: "s1", attachmentId: "att_x" });
		expect(result.ok).toBe(false);
		expect(!result.ok && result.error.code).toBe("not-found");
	});

	test("workspace verbs map onto the driver and shape the wire values", async () => {
		const dispatch = createRpcDispatcher(fakeDriver());
		const renamed = await dispatch("workspace.rename", { workspaceId: "/tmp/project", title: "Renamed" });
		expect(renamed.ok).toBe(true);
		expect(renamed.ok && (renamed.value as { workspace: { title: string } }).workspace.title).toBe("Renamed");
		const archived = await dispatch("workspace.archiveSession", { sessionId: "s1" });
		expect(archived).toEqual({ ok: true, value: { archivedSessionIds: [] } });
		const deleted = await dispatch("workspace.delete", { workspaceId: "/tmp/project" });
		expect(deleted).toEqual({ ok: true, value: { deleted: true } });
		const ordered = await dispatch("workspace.insertBefore", { workspaceId: "/tmp/project" });
		expect(ordered).toEqual({ ok: true, value: { workspaceIds: ["/tmp/project"] } });
		const moved = await dispatch("workspace.insertSessionBefore", {
			workspaceId: "/tmp/project",
			sessionId: "s1",
		});
		expect(moved.ok && (moved.value as { workspace: { sessionIds: string[] } }).workspace.sessionIds).toEqual(["s1"]);
		const created = await dispatch("workspace.create", { path: "/tmp/project" });
		expect(created.ok && (created.value as { created: boolean }).created).toBe(true);
	});

	test("host.listDirectory and host.createDirectory ride the driver", async () => {
		const dispatch = createRpcDispatcher(fakeDriver());
		const listed = await dispatch("host.listDirectory", {});
		expect(listed).toEqual({
			ok: true,
			value: { path: "/home/user", home: "/home/user", crumbs: [], entries: [], truncated: false },
		});
		const made = await dispatch("host.createDirectory", { path: "/tmp", name: "demo" });
		expect(made).toEqual({ ok: true, value: { path: "/tmp/demo" } });
	});

	test("goals/* unwrap the gateway args envelope and forward the CAS ref", async () => {
		const fake = fakeDriver();
		const dispatch = createRpcDispatcher(fake);
		const created = await dispatch("goals/create", { args: { agentId: "s1", request: { objective: "ship it" } } });
		expect(created).toEqual({ ok: true, value: { ref: { id: "goal-1", revision: 1 } } });
		const paused = await dispatch("goals/pause", { args: { agentId: "s1", ref: { id: "goal-1", revision: 1 } } });
		expect(paused.ok && (paused.value as { goal: { phase: string } }).goal.phase).toBe("paused");
		const resumed = await dispatch("goals/resume", { args: { agentId: "s1", ref: { id: "goal-1", revision: 2 } } });
		expect(resumed.ok && (resumed.value as { goal: { phase: string } }).goal.phase).toBe("active");
		const cleared = await dispatch("goals/clear", { args: { agentId: "s1", ref: { id: "goal-1", revision: 3 } } });
		expect(cleared).toEqual({ ok: true, value: { id: "goal-1", revision: 3 } });
		const malformed = await dispatch("goals/pause", { args: { agentId: "s1" } });
		expect(malformed.ok).toBe(false);
	});

	test("subagent verbs narrow payloads and answer the wire shapes", async () => {
		const fake = fakeDriver();
		fake.state.history.set("child-1", { events: [], hasMore: false });
		const dispatch = createRpcDispatcher(fake);
		const history = await dispatch("subagent.history", {
			parentSessionId: "s1",
			childSessionId: "child-1",
			mode: "continuable",
		});
		expect(history).toEqual({ ok: true, value: { events: [], hasMore: false } });
		const prompted = await dispatch("subagent.prompt", {
			parentSessionId: "s1",
			childSessionId: "child-1",
			mode: "continuable",
			content: [{ type: "text", text: "ping" }],
		});
		expect(prompted).toEqual({ ok: true, value: { messageId: "msg-1" } });
		const interrupted = await dispatch("subagent.interrupt", {
			parentSessionId: "s1",
			childSessionId: "child-1",
			mode: "continuable",
		});
		expect(interrupted).toEqual({ ok: true, value: { accepted: true } });
		const malformed = await dispatch("subagent.prompt", { parentSessionId: "s1" });
		expect(malformed.ok).toBe(false);
	});

	test("session.prompt accepts image parts", async () => {
		const fake = fakeDriver();
		const dispatch = createRpcDispatcher(fake);
		const result = await dispatch("session.prompt", {
			sessionId: "s1",
			content: [
				{ type: "text", text: "look at this" },
				{ type: "image", mediaType: "image/png", data: "aGVsbG8=" },
			],
		});
		expect(result.ok).toBe(true);
		const malformed = await dispatch("session.prompt", {
			sessionId: "s1",
			content: [{ type: "video", data: "x" }],
		});
		expect(malformed.ok).toBe(false);
	});
});
