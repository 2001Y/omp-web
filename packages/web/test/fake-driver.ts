/**
 * Scriptable fake driver for the web host contract tests.
 */

import type {
	WebDriver,
	WebHistoryOptions,
	WebHistoryResult,
	WebHostDescription,
	WebPromptOptions,
	WebPromptPart,
	WebQueueAction,
	WebQueueItem,
	WebSessionSummary,
	WebSkillEntry,
	WebStreamEvent,
	WebWorkspace,
} from "../src/protocol/driver";

/** Mutable fake state the tests drive. */
export interface FakeDriverState {
	host: WebHostDescription;
	workspaces: WebWorkspace[];
	sessions: WebSessionSummary[];
	history: Map<string, WebHistoryResult>;
	prompts: Array<{ sessionId: string; text: string }>;
	cancels: string[];
	renames: Array<{ sessionId: string; title: string }>;
	labels: Array<{ sessionId: string; entryId: string }>;
	navigations: Array<{
		sessionId: string;
		entryId: string;
		options?: { summarize?: boolean; customInstructions?: string };
	}>;
	forks: string[];
	created: Array<{ workspaceId?: string }>;
	attached: Array<{ sessionId: string; lastSeq: number }>;
	listeners: Set<(event: WebStreamEvent) => void>;
	commands: Array<{ name: string; description: string }>;
	skills: WebSkillEntry[];
	executedCommands: string[];
	queueUpdates: Array<{ sessionId: string; itemId: string; action: WebQueueAction }>;
	queues: Map<string, WebQueueItem[]>;
	documentOpens: boolean[];
	clientSettings: Record<string, Record<string, unknown>>;
	ompSettingsCatalogData: import("../src/protocol/omp-settings").WebOmpSettingsCatalog;
	ompSettingWrites: Array<{ key: string; value: unknown }>;
	providerLogouts: string[];
	modelRoleWrites: Array<{ role: string; selection?: { model: string; thinking?: string } }>;
	authLogins: Array<{
		attemptId: string;
		provider: string;
		code?: string;
		cancelled: boolean;
	}>;
}

/** One goal view fixture for the goal verbs. */
function goalViewFixture(
	phase: "active" | "paused" | "complete" = "active",
): import("../src/protocol/events").WebGoalView {
	return {
		goal: { id: "goal-1", revision: 1, objective: "ship it", phase, maxGoalRounds: 0 },
		roundsStarted: 0,
		createdAt: 1,
		updatedAt: 1,
		activation: "armed",
	};
}

/** Build a fake driver over fresh state. */
export function fakeDriver(overrides: Partial<FakeDriverState> = {}): WebDriver & { state: FakeDriverState } {
	const state: FakeDriverState = {
		host: {
			version: "18.0.4-test",
			cwd: "/tmp/project",
			home: "/home/user",
			attachedSessions: 1,
			canOpenPath: false,
		},
		workspaces: [
			{
				workspaceId: "/tmp/project",
				path: "/tmp/project",
				title: "project",
				sessionIds: ["s1"],
				updatedAt: 1,
			},
		],
		sessions: [{ sessionId: "s1", updatedAt: 1, running: false, blank: false, cwd: "/tmp/project" }],
		history: new Map(),
		prompts: [],
		cancels: [],
		renames: [],
		labels: [],
		navigations: [],
		forks: [],
		created: [],
		attached: [],
		listeners: new Set(),
		commands: [],
		skills: [],
		executedCommands: [],
		queueUpdates: [],
		queues: new Map(),
		documentOpens: [],
		clientSettings: {},
		ompSettingsCatalogData: { tabs: [], models: [], modelRoles: [], providers: [] },
		ompSettingWrites: [],
		providerLogouts: [],
		modelRoleWrites: [],
		authLogins: [],
		...overrides,
	};
	const notify = (event: WebStreamEvent): void => {
		for (const listener of state.listeners) listener(event);
	};
	const driver: WebDriver & { state: FakeDriverState } = {
		state,
		describeHost: async () => state.host,
		listWorkspaces: async () => ({ workspaces: state.workspaces, archivedSessionIds: [] }),
		listSessions: async () => state.sessions,
		searchSessions: async () => ({ items: [], hasMore: false }),
		sessionAttachment: async () => undefined,
		archiveSession: async () => ({ archivedSessionIds: [] }),
		renameWorkspace: async (workspaceId: string, title: string) => {
			const workspace = state.workspaces.find(item => item.workspaceId === workspaceId);
			if (workspace === undefined) throw new Error(`no workspace ${workspaceId}`);
			return { workspace: { ...workspace, title } };
		},
		deleteWorkspace: async () => ({ deleted: true as const }),
		insertWorkspaceBefore: async (_workspaceId: string, _beforeWorkspaceId?: string) => ({
			workspaceIds: state.workspaces.map(item => item.workspaceId),
		}),
		insertSessionBefore: async (workspaceId: string, _sessionId: string, _beforeSessionId?: string) => {
			const workspace = state.workspaces.find(item => item.workspaceId === workspaceId);
			if (workspace === undefined) throw new Error(`no workspace ${workspaceId}`);
			return { workspace };
		},
		createWorkspace: async (path: string) => {
			const workspace: WebWorkspace = {
				workspaceId: path,
				path,
				title: path.split("/").filter(Boolean).at(-1) ?? path,
				sessionIds: [],
				updatedAt: Date.now(),
			};
			return { workspace, created: true };
		},
		listDirectory: async (path?: string) => ({
			path: path ?? state.host.home,
			home: state.host.home,
			crumbs: [],
			entries: [],
			truncated: false,
		}),
		createDirectory: async (path: string, name: string) => ({ path: `${path}/${name}` }),
		goalCreate: async (_sessionId: string, _objective: string) => ({ ref: { id: "goal-1", revision: 1 } }),
		goalEdit: async () => goalViewFixture(),
		goalPause: async () => goalViewFixture("paused"),
		goalResume: async () => goalViewFixture(),
		goalComplete: async () => goalViewFixture("complete"),
		goalClear: async (_sessionId: string, ref: { id: string; revision: number }) => ref,
		subagentHistory: async (_parent: string, child: string, _options: WebHistoryOptions) => {
			const result = state.history.get(child);
			if (result === undefined) throw new Error(`no history for ${child}`);
			return result;
		},
		promptSubagent: async () => ({ messageId: "msg-1" }),
		interruptSubagent: async () => {},
		createSession: async options => {
			state.created.push(options);
			return { sessionId: "s-new" };
		},
		history: async (sessionId: string, options: WebHistoryOptions): Promise<WebHistoryResult> => {
			const result = state.history.get(sessionId);
			if (result === undefined) throw new Error(`no history for ${sessionId}`);
			if (options.beforeSeq !== undefined) {
				return { ...result, events: result.events.filter(event => event.seq < options.beforeSeq!) };
			}
			return result;
		},
		prompt: async (sessionId: string, content: WebPromptPart[], _options?: WebPromptOptions) => {
			state.prompts.push({
				sessionId,
				text: content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map(part => part.text)
					.join("\n"),
			});
		},
		updateQueue: async (sessionId, itemId, action) => {
			state.queueUpdates.push({ sessionId, itemId, action });
		},
		queuedMessages: async sessionId => state.queues.get(sessionId) ?? [],
		sessionJobs: async () => [],
		cancel: async sessionId => {
			state.cancels.push(sessionId);
		},
		models: async () => ({
			current: { provider: "p", model: "m" },
			routable: true,
			groups: [{ id: "p", name: "P", models: [{ id: "m", name: "M" }] }],
		}),
		selectModel: async (
			_sessionId: string,
			selection: { provider: string; model: string; reasoningEffort?: string },
		) => ({
			selected: selection,
		}),
		listCommands: async () => state.commands,
		listSkills: async () => state.skills,
		exportSessionLog: async (sessionId: string) => {
			if (!state.sessions.some(session => session.sessionId === sessionId)) return undefined;
			return { entries: [{ name: `${sessionId}.jsonl`, data: new TextEncoder().encode('{"type":"session"}') }] };
		},
		executeCommand: async (_sessionId: string, line: string) => ({
			commandId: `cmd-${state.executedCommands.push(line)}`,
			result: { kind: "success" as const },
		}),
		settingsOverview: async () => ({ writable: false, hasDocument: true }),
		openSettingsDocument: async () => {
			state.documentOpens.push(true);
		},
		clientSettingNamespaces: async () => Object.entries(state.clientSettings).map(([ns, value]) => ({ ns, value })),
		ompSettingsCatalog: async () => state.ompSettingsCatalogData,
		setOmpSetting: async (key, value) => {
			state.ompSettingWrites.push({ key, value });
		},
		logoutProvider: async provider => {
			state.providerLogouts.push(provider);
		},
		startAuthLogin: async provider => {
			const attempt = { attemptId: `attempt-${state.authLogins.length + 1}`, provider, cancelled: false };
			state.authLogins.push(attempt);
			return {
				attemptId: attempt.attemptId,
				provider,
				state: "pending",
				auth: { url: "https://example.test/device", instructions: "Enter code: WXYZ-1234" },
			};
		},
		authLoginStatus: async attemptId => {
			const attempt = state.authLogins.find(entry => entry.attemptId === attemptId);
			if (attempt === undefined) return undefined;
			if (attempt.cancelled) {
				return { attemptId, provider: attempt.provider, state: "error", error: "Login cancelled" };
			}
			if (attempt.code !== undefined) {
				return { attemptId, provider: attempt.provider, state: "done", identity: "user@example.test" };
			}
			return {
				attemptId,
				provider: attempt.provider,
				state: "pending",
				auth: { url: "https://example.test/device", instructions: "Enter code: WXYZ-1234" },
			};
		},
		submitAuthCode: async (attemptId, code) => {
			const attempt = state.authLogins.find(entry => entry.attemptId === attemptId);
			if (attempt === undefined) throw new Error(`omp-web: unknown login attempt "${attemptId}"`);
			attempt.code = code;
		},
		cancelAuthLogin: async attemptId => {
			const attempt = state.authLogins.find(entry => entry.attemptId === attemptId);
			if (attempt === undefined) throw new Error(`omp-web: unknown login attempt "${attemptId}"`);
			attempt.cancelled = true;
		},
		setModelRole: async (role, selection) => {
			state.modelRoleWrites.push({ role, selection });
		},
		mutateClientSetting: async (ns, ops) => {
			const section = { ...(state.clientSettings[ns] ?? {}) };
			for (const op of ops) {
				const key = op.path.join(".");
				if (op.op === "set") section[key] = op.value;
				else delete section[key];
			}
			state.clientSettings[ns] = section;
			return { ns, value: section };
		},
		listSubagents: async () => ({ entries: [], parentAvailable: true }),
		listFileReferences: async () => [],
		historyTree: async () => ({
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
		}),
		navigateToEntry: async (sessionId: string, entryId: string, options?) => {
			state.navigations.push({ sessionId, entryId, options });
			return {};
		},
		setEntryLabel: async (sessionId: string, entryId: string) => {
			state.labels.push({ sessionId, entryId });
		},
		fork: async (sessionId: string) => {
			state.forks.push(sessionId);
			return { sessionId: `fork-of-${sessionId}` };
		},
		rename: async (sessionId: string, title: string) => {
			state.renames.push({ sessionId, title });
			return { title, seq: 99 };
		},
		subscribe: listener => {
			state.listeners.add(listener);
			return () => {
				state.listeners.delete(listener);
			};
		},
		attachedSessions: async () => state.attached,
	};
	// Expose the pump for tests without reaching through the interface.
	Object.assign(driver, { notify });
	return driver;
}
