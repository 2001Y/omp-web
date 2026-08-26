/**
 * Web driver mode-verb contracts (the audit-fix batch):
 *
 * - attachments: content-derived ids, dimension probing, session-log scan
 *   (the `session.attachment` authorization boundary), and the wire image
 *   blocks the translator now emits;
 * - reset_boundary: the collapsed transcript fold starts after the latest
 *   /clear marker (TUI rebuild parity);
 * - workspace overrides: archive/rename/order persistence;
 * - goal verbs: CAS refs, phase mapping, and the goal projection frames the
 *   ui-goal bar consumes;
 * - session.search over persisted sessions.
 *
 * The agent dir redirects into the temp tree so `SessionManager.listAll`
 * sees exactly the fixture sessions.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { refreshDirsFromEnv, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import type { WebStreamEvent } from "@oh-my-pi/web";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { attachmentIdOf, attachmentRefOf, collectSessionAttachments } from "../../src/modes/web/attachments";
import { historyItemsOf, OmpWebDriver, titleFromFirstMessage } from "../../src/modes/web/driver";
import { mapToolResultMessage, mapUserMessage } from "../../src/modes/web/translate";
import { WorkspaceOverrides } from "../../src/modes/web/workspace-state";
import type { AgentSession } from "../../src/session/agent-session";
import { AgentSession as AgentSessionImpl } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import type { FileEntry } from "../../src/session/session-entries";
import { SessionManager } from "../../src/session/session-manager";
import { createTools, type ToolSession } from "../../src/tools";

/** A 1×1 transparent PNG. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function imagePart(data = PNG_1X1): ImageContent {
	return { type: "image", data, mimeType: "image/png" };
}

describe("web attachments", () => {
	it("derives a stable content-hash id with probed dimensions", () => {
		const first = attachmentRefOf("image/png", PNG_1X1);
		const second = attachmentRefOf("image/png", PNG_1X1);
		expect(first).toBeDefined();
		expect(second?.attachmentId).toBe(first?.attachmentId);
		expect(first?.attachmentId).toBe(attachmentIdOf("image/png", PNG_1X1));
		expect(first?.width).toBe(1);
		expect(first?.height).toBe(1);
		expect(first?.bytes).toBeGreaterThan(0);
		// Out-of-vocabulary or undecodable payloads carry no reference.
		expect(attachmentRefOf("image/tiff", PNG_1X1)).toBeUndefined();
		expect(attachmentRefOf("image/png", "")).toBeUndefined();
	});

	it("maps image blocks onto wire image blocks in user, assistant, and tool-result seats", () => {
		const user = mapUserMessage({
			id: "u1",
			role: "user",
			content: [{ type: "text", text: "see" }, imagePart()],
			timestamp: 1,
		} as never);
		const image = user.content.find(block => block.type === "image");
		expect(image).toBeDefined();
		expect(image && image.type === "image" ? image.attachment.attachmentId : undefined).toBe(
			attachmentIdOf("image/png", PNG_1X1),
		);

		const toolResult = mapToolResultMessage(
			{
				id: "t1",
				role: "toolResult",
				toolCallId: "call-1",
				content: [imagePart()],
				timestamp: 2,
			} as never,
			"call-1",
		);
		const block = toolResult.content[0];
		expect(block?.type).toBe("tool-result");
		if (block?.type === "tool-result") {
			expect(block.content.some(item => item.type === "image")).toBe(true);
		}
	});

	it("collects session attachments from the entry log (the fetch authorization boundary)", () => {
		const entries = [
			{
				id: "e1",
				type: "message",
				timestamp: new Date(1).toISOString(),
				message: { id: "m1", role: "user", content: [imagePart()], timestamp: 1 },
			},
		] as unknown as FileEntry[];
		const collected = collectSessionAttachments(entries);
		const payload = collected.get(attachmentIdOf("image/png", PNG_1X1));
		expect(payload?.data).toBe(PNG_1X1);
		expect(payload?.mediaType).toBe("image/png");
	});
});

describe("history fold reset boundary", () => {
	function messageEntry(id: string, text: string): FileEntry {
		return {
			id,
			parentId: null,
			type: "message",
			timestamp: new Date().toISOString(),
			message: { id, role: "user", content: text, timestamp: Date.now() },
		} as unknown as FileEntry;
	}

	it("cuts the collapsed transcript at the latest reset_boundary", () => {
		const before = messageEntry("a", "before clear");
		const boundary = {
			id: "b",
			parentId: "a",
			type: "reset_boundary",
			timestamp: new Date().toISOString(),
		} as unknown as FileEntry;
		const after = { ...messageEntry("c", "after clear"), parentId: "b" } as unknown as FileEntry;
		const items = historyItemsOf([before, boundary, after]);
		expect(items).toHaveLength(1);
		const first = items[0];
		expect(first?.kind).toBe("message");
		if (first?.kind === "message") {
			expect((first.message as { content: string }).content).toBe("after clear");
		}
	});

	it("keeps the full fold when no boundary exists", () => {
		const first = messageEntry("a", "one");
		const second = { ...messageEntry("b", "two"), parentId: "a" } as unknown as FileEntry;
		expect(historyItemsOf([first, second])).toHaveLength(2);
	});
});

describe("workspace overrides", () => {
	it("persists archive, rename, and ordering across instances", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-overrides-"));
		try {
			const file = path.join(tempDir, "web-workspaces.json");
			const overrides = new WorkspaceOverrides(file);
			overrides.archiveSession("s1");
			overrides.renameWorkspace("/w/a", "Renamed");
			overrides.planWorkspace("/w/empty");
			overrides.insertWorkspaceBefore("/w/b", "/w/a", ["/w/a", "/w/b", "/w/c"]);
			overrides.insertSessionBefore("/w/a", "s2", "s1", ["s1", "s2"]);
			const reloaded = new WorkspaceOverrides(file);
			expect(reloaded.archivedSessionIds()).toEqual(["s1"]);
			expect(reloaded.workspaceTitle("/w/a")).toBe("Renamed");
			expect(reloaded.plannedWorkspaces()).toEqual(["/w/empty"]);
			expect(reloaded.applyWorkspaceOrder(["/w/a", "/w/b", "/w/c"])).toEqual(["/w/b", "/w/a", "/w/c"]);
			expect(reloaded.applySessionOrder("/w/a", ["s1", "s2"])).toEqual(["s2", "s1"]);
			reloaded.forgetWorkspace("/w/a");
			expect(reloaded.workspaceTitle("/w/a")).toBeUndefined();
			expect(reloaded.applyWorkspaceOrder(["/w/a", "/w/b"])).toEqual(["/w/b", "/w/a"]);
		} finally {
			removeSyncWithRetries(tempDir);
		}
	});
});

describe("OmpWebDriver goal and search verbs", () => {
	let tempDir: string;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let driver: OmpWebDriver;
	let events: WebStreamEvent[];
	let savedAgentDir: string | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `omp-web-modes-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(tempDir, "agent");
		refreshDirsFromEnv();
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
		};
		const tools = await createTools(toolSession);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => undefined,
			initialState: { model, systemPrompt: ["test"], tools },
		});
		authStorage = await AuthStorage.create(":memory:");
		session = new AgentSessionImpl({
			agent,
			sessionManager: SessionManager.create(tempDir),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
		});
		events = [];
		driver = new OmpWebDriver(session);
		driver.subscribe(event => {
			events.push(event);
		});
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		refreshDirsFromEnv();
		if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	function goalProjections(): Array<Extract<WebStreamEvent, { kind: "session-projection"; key: "goal" }>> {
		return events.filter(
			(event): event is Extract<WebStreamEvent, { kind: "session-projection"; key: "goal" }> =>
				event.kind === "session-projection" && event.key === "goal",
		);
	}

	it("runs the goal lifecycle with CAS refs and projection frames", async () => {
		const sessionId = session.sessionId;
		const created = await driver.goalCreate(sessionId, "ship the audit fixes");
		expect(created.ref.revision).toBe(1);
		expect(session.getGoalModeState()?.goal.objective).toBe("ship the audit fixes");
		const projections = goalProjections();
		expect(projections.at(-1)?.value?.goal.phase).toBe("active");

		// Stale refs are rejected (the CAS contract).
		await expect(
			driver.goalEdit(sessionId, { id: created.ref.id, revision: 99 }, { objective: "x" }),
		).rejects.toThrow(/stale/);

		const edited = await driver.goalEdit(sessionId, created.ref, { objective: "ship everything" });
		expect(edited.goal.objective).toBe("ship everything");
		expect(edited.goal.revision).toBe(2);

		const paused = await driver.goalPause(sessionId, { id: edited.goal.id, revision: edited.goal.revision });
		expect(paused.goal.phase).toBe("paused");
		expect(goalProjections().at(-1)?.value?.goal.phase).toBe("paused");

		const resumed = await driver.goalResume(sessionId, { id: paused.goal.id, revision: paused.goal.revision });
		expect(resumed.goal.phase).toBe("active");

		const completed = await driver.goalComplete(sessionId, {
			id: resumed.goal.id,
			revision: resumed.goal.revision,
		});
		expect(completed.goal.phase).toBe("complete");
		// Completion exits goal mode agent-side while the terminal projection stands.
		expect(session.getGoalModeState()).toBeUndefined();
		expect(goalProjections().at(-1)?.value?.goal.phase).toBe("complete");
	});

	it("seeds the goal and imageLimits projections on the history tail page", async () => {
		const sessionId = session.sessionId;
		await driver.goalCreate(sessionId, "keep going");
		const history = await driver.history(sessionId, {});
		expect(history.goal?.goal.objective).toBe("keep going");
		expect(history.imageLimits?.mediaTypes).toContain("image/png");
	});

	it("serves attachments through the session log boundary", async () => {
		session.sessionManager.appendMessage({
			id: crypto.randomUUID(),
			role: "user",
			content: [imagePart()],
			timestamp: Date.now(),
		} as never);
		const id = attachmentIdOf("image/png", PNG_1X1);
		const found = await driver.sessionAttachment(session.sessionId, id);
		expect(found?.data).toBe(PNG_1X1);
		expect(found?.attachment.width).toBe(1);
		expect(await driver.sessionAttachment(session.sessionId, "att_missing")).toBeUndefined();
	});

	it("searches persisted sessions by title and message text", async () => {
		const other = SessionManager.create(tempDir);
		other.appendMessage({
			id: crypto.randomUUID(),
			role: "user",
			content: "refactor the frobnicate pipeline",
			timestamp: Date.now(),
		} as never);
		await other.ensureOnDisk();
		await other.flush();
		const sessions = await driver.listSessions();
		const target = sessions.find(summary => summary.sessionId !== session.sessionId);
		expect(target).toBeDefined();
		const result = await driver.searchSessions("frobnicate");
		expect(result.items.some(item => item.sessionId === target!.sessionId)).toBe(true);
		const miss = await driver.searchSessions("zzz-no-such-token-zzz");
		expect(miss.items).toEqual([]);
	});

	it("seeds the history baseline with the persisted title, never the message-derived one", async () => {
		// No messages at all: the derivation has nothing to read, but the
		// persisted title still seeds the baseline (compacted autonomous
		// sessions land here — their restored window holds no user message).
		await session.setSessionName("Curated title", "user");
		const empty = await driver.history(session.sessionId, {});
		expect(empty.title).toBe("Curated title");

		// With messages present the persisted title still wins over the
		// first-user-message derivation.
		session.agent.state.messages.push({
			id: crypto.randomUUID(),
			role: "user",
			content: "the first prompt that would otherwise become the title",
			timestamp: Date.now(),
		} as never);
		const titled = await driver.history(session.sessionId, {});
		expect(titled.title).toBe("Curated title");
	});

	it("derives the baseline title from the first user message only when untitled", async () => {
		// The derivation reads the live message window (agent state), which is
		// what a restored or active session serves.
		session.agent.state.messages.push({
			id: crypto.randomUUID(),
			role: "user",
			content: "derive me as the fallback title",
			timestamp: Date.now(),
		} as never);
		const history = await driver.history(session.sessionId, {});
		expect(history.title).toBe("derive me as the fallback title");
	});

	it("treats the listing's (no messages) placeholder as untitled", () => {
		expect(titleFromFirstMessage("(no messages)")).toBeUndefined();
		expect(titleFromFirstMessage("")).toBeUndefined();
		expect(titleFromFirstMessage(undefined)).toBeUndefined();
		expect(titleFromFirstMessage("  real prompt  ")).toBe("real prompt");
		expect(titleFromFirstMessage("x".repeat(80))).toHaveLength(60);
	});

	it("deep-scans past the listing's 4KB prefix window", async () => {
		const other = SessionManager.create(tempDir);
		// Push the needle beyond the listing's 4KB prefix: the cheap pass must
		// miss, and only the raw full-text fallback can find it.
		other.appendMessage({
			id: crypto.randomUUID(),
			role: "user",
			content: `filler ${"a".repeat(5000)}`,
			timestamp: Date.now(),
		} as never);
		other.appendMessage({
			id: crypto.randomUUID(),
			role: "user",
			content: "buried zyx-deep-needle token",
			timestamp: Date.now(),
		} as never);
		await other.ensureOnDisk();
		await other.flush();
		const sessions = await driver.listSessions();
		const target = sessions.find(summary => summary.sessionId !== session.sessionId);
		expect(target).toBeDefined();
		const result = await driver.searchSessions("zyx-deep-needle");
		const hit = result.items.find(item => item.sessionId === target!.sessionId);
		expect(hit).toBeDefined();
		expect(hit!.snippet).toContain("zyx-deep-needle");
	});

	it("toggles loop mode through the command bridge without a prompt", async () => {
		const armed = await driver.executeCommand(session.sessionId, "/loop 3");
		expect(armed?.result.kind).toBe("success");
		expect(armed?.result.kind === "success" ? armed.result.text : "").toContain("Loop mode on");
		const disarmed = await driver.executeCommand(session.sessionId, "/loop");
		expect(disarmed?.result.kind).toBe("success");
		expect(disarmed?.result.kind === "success" ? disarmed.result.text : "").toContain("disabled");
	});
});
