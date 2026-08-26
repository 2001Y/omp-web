/**
 * Web driver session-switch contracts: the mode reconciler keeps plan state
 * honest across switches (a mode active on the source must not leak into the
 * target, and a persisted mode must re-enter on switch-in), the client gets
 * the session-attached re-baseline frame, and cancel settles parked asks.
 *
 * The agent dir is redirected into the temp tree so `SessionManager.listAll`
 * sees exactly the fixture sessions (never the developer's real bucket).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { refreshDirsFromEnv, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import type { WebStreamEvent } from "@oh-my-pi/web";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { OmpWebDriver } from "../../src/modes/web/driver";
import type { AgentSession } from "../../src/session/agent-session";
import { AgentSession as AgentSessionImpl } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { createTools, type ToolSession } from "../../src/tools";

describe("OmpWebDriver session switching", () => {
	let tempDir: string;
	let session: AgentSession;
	let authStorage: AuthStorage;
	let driver: OmpWebDriver;
	let events: WebStreamEvent[];
	let savedAgentDir: string | undefined;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `omp-web-switch-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		// Redirect the agent dir BEFORE any session manager work so the default
		// session bucket lands inside the temp tree.
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

	/** Persist a second (plan-free) session into the same bucket. */
	async function createColdSession(): Promise<string> {
		const other = SessionManager.create(tempDir);
		other.appendModeChange("none");
		// The lazy gate writes a session file only once output exists (or is
		// forced); a mode-only fixture session must force it.
		await other.ensureOnDisk();
		await other.flush();
		const sessions = await driver.listSessions();
		const cold = sessions.find(summary => summary.sessionId !== session.sessionId);
		expect(cold).toBeDefined();
		return cold!.sessionId;
	}

	it("clears a leaked plan state on switch-out and re-enters a persisted plan on switch-in", async () => {
		// Session A carries a persisted plan mode_change AND the live state.
		session.sessionManager.appendModeChange("plan", { planFilePath: "local://PLAN.md" });
		session.setPlanModeState({
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
			reentry: false,
		});
		await session.sessionManager.ensureOnDisk();
		await session.sessionManager.flush();
		const aId = session.sessionId;
		const bId = await createColdSession();

		// Switch out: the target has no plan mode — the state must not leak.
		await driver.history(bId, {});
		expect(session.sessionId).toBe(bId);
		expect(session.getPlanModeState()).toBeUndefined();

		// Switch back: the persisted mode_change re-enters plan mode.
		await driver.history(aId, {});
		expect(session.sessionId).toBe(aId);
		expect(session.getPlanModeState()?.enabled).toBe(true);
	});

	it("broadcasts the session-attached re-baseline when the window moves", async () => {
		const bId = await createColdSession();
		await driver.history(bId, {});
		const attached = events.filter(
			(event): event is Extract<WebStreamEvent, { kind: "session-attached" }> => event.kind === "session-attached",
		);
		expect(attached.at(-1)?.sessionId).toBe(bId);
		// An empty cold session baselines at -1 (the dsh fixture's own value).
		expect(attached.at(-1)?.lastSeq).toBeGreaterThanOrEqual(-1);
	});

	it("cancel settles the session's parked asks before aborting", async () => {
		await driver.cancel(session.sessionId);
		const cancelAsks = events.filter(
			(event): event is Extract<WebStreamEvent, { kind: "cancel-asks" }> => event.kind === "cancel-asks",
		);
		expect(cancelAsks).toHaveLength(1);
		expect(cancelAsks[0].sessionId).toBe(session.sessionId);
	});
});
