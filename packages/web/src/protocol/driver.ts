/**
 * Backend capability interface for the omp web GUI host.
 *
 * Dependency-direction boundary of the additive web fork: `@oh-my-pi/web` never
 * imports the coding agent. The web mode (`packages/coding-agent/src/modes/web/`)
 * implements this interface against the agent SDK and injects it into
 * {@link startWebServer}; every OMP concept crosses this seam as one of the
 * host-neutral types below (the session-event vocabulary lives in
 * `./events.ts`).
 */

import type { WebMessage, WebSessionEvent, WebStreamEvent } from "./events";

export type { WebSessionEvent, WebStreamEvent } from "./events";

/** Host snapshot mirrored onto the `host.describe` response value. */
export interface WebHostDescription {
	/** Host application version (the omp CLI version). */
	version: string;
	/** Host process working directory; the root for session persistence and tool execution. */
	cwd: string;
	/** Host account home directory. */
	home: string;
	/** Default provider route id for new sessions, when one is configured. */
	provider?: string;
	/** Default model id for new sessions, when one is configured. */
	model?: string;
	/** Count of currently attached sessions (those with a live agent). */
	attachedSessions: number;
	/** Whether this deployment can hand a path to a user-visible native desktop. */
	canOpenPath: boolean;
}

/** One persisted session as seen by the session list. */
export interface WebSessionSummary {
	/** Stable session identity. */
	sessionId: string;
	/** Later of creation and the latest human-authored prompt, epoch milliseconds. */
	updatedAt: number;
	/** Whether the attached agent is running; false for cold (unattached) sessions. */
	running: boolean;
	/** Conversation-not-started bit: true while no turn has run. */
	blank: boolean;
	/** Fork/spawn lineage; absent for root sessions. */
	parentSessionId?: string;
	/** Coarse durable origin used by navigation surfaces. */
	origin?: "subagent";
	/** Session working directory; absent when unrecorded. */
	cwd?: string;
	/** Conversation title when known; seeds the sidebar row via the projections block. */
	title?: string;
}

/**
 * One workspace row. Per the omp-web design note (NOTES.md), workspaces are
 * derived from the session-storage layout: one `~/.omp/agent/sessions`
 * cwd bucket = one workspace, holding that project's sessions.
 */
export interface WebWorkspace {
	/** Stable workspace identity (the canonical project path). */
	workspaceId: string;
	/** Canonical project directory path. */
	path: string;
	/** Display title (the path basename). */
	title: string;
	/** Sessions accounted under this workspace. */
	sessionIds: string[];
	/** Latest session activity in the bucket, epoch milliseconds. */
	updatedAt: number;
}

/** One selectable model inside its provider group. */
export interface WebModelEntry {
	/** Provider-owned model id. */
	id: string;
	/** Display name. */
	name: string;
	/** Selectable reasoning metadata for this exact route. */
	reasoning?: WebModelReasoning;
}

/** One provider group of the model catalog. */
export interface WebModelProviderGroup {
	/** Provider route id used for requests. */
	id: string;
	/** Provider display name. */
	name: string;
	/** Models in provider-preferred order. */
	models: WebModelEntry[];
}

/** One selectable reasoning effort. */
export interface WebReasoningEffort {
	id: string;
	name: string;
}

/** Selectable reasoning metadata for one exact model route. */
export interface WebModelReasoning {
	efforts: WebReasoningEffort[];
	defaultEffort?: string;
}

/** Detached model-directory snapshot for one session. */
export interface WebSessionModels {
	/** Current selection for the session's next step. */
	current: { provider: string; model: string; reasoningEffort?: string };
	/** Whether the current route can serve requests at all. */
	routable: boolean;
	/** Successfully loaded provider groups. */
	groups: WebModelProviderGroup[];
}

/** One slash-command directory entry. */
export interface WebCommandDescriptor {
	name: string;
	description: string;
	/**
	 * Free-form argument claim: declared commands intercept `/name args` on
	 * Enter (the dsh leadingInput claim); undeclared commands execute only on
	 * the bare token.
	 */
	input?: { hint: string; images?: boolean };
}

/** One user-invocable skill row of the `skill.list` catalog. */
export interface WebSkillEntry {
	/** The `/name` the user types (`skill:<name>` while skill commands are enabled). */
	name: string;
	description: string;
	/** False for `disable-model-invocation` skills (user-only, absent from the model catalog). */
	modelInvocable: boolean;
}

/** Result of one slash-command execution. */
export type WebCommandResult = { kind: "success"; text?: string } | { kind: "error"; text: string };

/** One settled command execution (the wire CommandExecution shape). */
export interface WebCommandExecution {
	/** Pairing id for the run/done lifecycle events (the M3 event bridge). */
	commandId: string;
	result: WebCommandResult;
}

/** Prompt content part: visible text or one raster image (base64). */
export type WebPromptPart =
	| { type: "text"; text: string }
	| { type: "image"; mediaType: string; data: string; name?: string };

/** History window options (page alignment stays the driver's concern in M1). */
export interface WebHistoryOptions {
	/** Return events with seq strictly below this anchor (load-older path). */
	beforeSeq?: number;
	/** Page budget in messages. */
	maxMessages?: number;
}

/** History read result. */
export interface WebHistoryResult {
	events: WebSessionEvent[];
	hasMore: boolean;
	/** Session title when known; seeds the client's `title` projection baseline. */
	title?: string;
	/** Plan collaboration state when known; seeds the `plan` projection baseline. */
	plan?: import("./events").WebPlanProjection;
	/**
	 * Goal state when known; seeds the `goal` projection baseline. Explicit
	 * `null` clears a stale client-side goal (the tail page always carries the
	 * key once goal mode was ever entered, mirroring the dsh replay semantics).
	 */
	goal?: import("./events").WebGoalProjection | null;
	/** Deployment image-intake limits; seeds the `imageLimits` projection baseline. */
	imageLimits?: import("./events").WebImageLimits;
}

/** Prompt options: the client's delivery mode. */
export interface WebPromptOptions {
	/** `queue` (default) delivers when idle or as a follow-up; `steer` interrupts. */
	mode?: "queue" | "steer";
}

/** One pending queue occurrence (the `session/queue` snapshot row). */
export interface WebQueueItem {
	id: string;
	placement: "queued" | "steering";
	message: WebMessage;
}

/** A client-requested mutation of one still-pending queue item. */
export type WebQueueAction = { kind: "edit"; content: WebPromptPart[] } | { kind: "remove" } | { kind: "steer" };

/**
 * History-node display kind: message roles plus the bookkeeping entry
 * categories the TUI tree renders in its `all` filter mode.
 */
export type WebHistoryKind =
	| "user"
	| "assistant"
	| "developer"
	| "bashExecution"
	| "customMessage"
	| "toolResult"
	| "compaction"
	| "branchSummary"
	| "modelChange"
	| "thinkingLevelChange"
	| "serviceTierChange"
	| "titleChange"
	| "modeChange"
	| "credentialPin"
	| "ttsrInjection"
	| "modelUsage"
	| "resetBoundary"
	| "sessionInit"
	| "custom"
	| "label";

/**
 * One node of the session history tree (any entry type, TUI `/tree` parity):
 * the display vocabulary mirrors the TUI selector so the web view filters,
 * orders, and indents with identical semantics.
 */
export interface WebHistoryNode {
	/** Entry id (the navigateTree target). */
	id: string;
	/** Parent entry id; null at a root. */
	parentId: string | null;
	/** Display kind (message role or bookkeeping category). */
	kind: WebHistoryKind;
	/** Value text (message content, tool summary, or the entry's payload). */
	text: string;
	/** User label attached to the entry, if any (TUI Shift+L). */
	label?: string;
	timestamp: number;
	/** True while the entry sits on the current (active-leaf) path. */
	onCurrentPath: boolean;
	/** True for the session's active leaf (the tree's initial selection). */
	currentLeaf: boolean;
	/** Bookkeeping entry hidden by the TUI default tree filter. */
	bookkeeping: boolean;
	/** Assistant message carrying only tool calls (no text content). */
	toolCallsOnly: boolean;
	/** Assistant message that ended in an error or abort presentation. */
	errorOrAborted: boolean;
}

/**
 * The backend face the web server drives. Methods may throw; the RPC layer
 * folds every throw into the wire error shape.
 */
export interface WebDriver {
	/** @returns the one-shot host snapshot served by `host.describe`. */
	describeHost(): Promise<WebHostDescription>;
	/** @returns every workspace derived from the session-storage buckets, plus the archived-session set. */
	listWorkspaces(): Promise<{ workspaces: WebWorkspace[]; archivedSessionIds: string[] }>;
	/** @returns persisted sessions (all workspaces; the caller groups). */
	listSessions(): Promise<WebSessionSummary[]>;
	/**
	 * Full-text session search (`session.search`): matches titles and message
	 * content across every persisted session; snippets are bounded to the wire
	 * limit (240 code points) and the result set to 20 rows.
	 */
	searchSessions(query: string): Promise<{ items: Array<{ sessionId: string; snippet: string }>; hasMore: boolean }>;
	/**
	 * Fetches one durable image (`session.attachment`): the session's own log
	 * must reference the attachmentId (session-scoped authorization), else
	 * undefined. Data returns base64.
	 */
	sessionAttachment(
		sessionId: string,
		attachmentId: string,
	): Promise<{ attachment: import("./events").WebImageAttachmentRef; data: string } | undefined>;
	/** Hides a session from the sidebar without deleting its log (`workspace.archiveSession`). */
	archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }>;
	/** Overrides one workspace's display title (`workspace.rename`). */
	renameWorkspace(workspaceId: string, title: string): Promise<{ workspace: WebWorkspace }>;
	/**
	 * Removes one workspace's registration (title/order/planned overrides);
	 * session logs are kept — the vendored confirm dialog promises as much.
	 * A cwd bucket with sessions reappears on the next list.
	 */
	deleteWorkspace(workspaceId: string): Promise<{ deleted: true }>;
	/** Persists a workspace display-order move (`workspace.insertBefore`; anchor omitted = append). */
	insertWorkspaceBefore(workspaceId: string, beforeWorkspaceId?: string): Promise<{ workspaceIds: string[] }>;
	/** Persists an in-workspace session-order move (`workspace.insertSessionBefore`). */
	insertSessionBefore(
		workspaceId: string,
		sessionId: string,
		beforeSessionId?: string,
	): Promise<{ workspace: WebWorkspace }>;
	/** Adopts an existing directory as a workspace (`workspace.create`). */
	createWorkspace(path: string): Promise<{ workspace: WebWorkspace; created: boolean }>;
	/** Lists one directory for the browser directory picker (`host.listDirectory`). */
	listDirectory(path?: string): Promise<{
		path: string;
		home: string;
		crumbs: Array<{ name: string; path: string; hidden: boolean }>;
		entries: Array<{ name: string; path: string; hidden: boolean }>;
		truncated: boolean;
	}>;
	/** Creates one directory segment for the picker (`host.createDirectory`). */
	createDirectory(path: string, name: string): Promise<{ path: string }>;
	/**
	 * Creates a session (reusing the attached session when it is still blank,
	 * matching the client's New Session semantics) and announces it through the
	 * subscription stream as a `session-added` notification.
	 * @param options - `workspaceId` names the project bucket; naming a
	 * directory other than the attached session's throws (cross-workspace
	 * creation arrives with the multi-session factory).
	 */
	createSession(options: { workspaceId?: string }): Promise<{ sessionId: string }>;
	/**
	 * Reads a window of translated history. Cold sessions read from
	 * persistence; the attached session reads the translator's canonical log
	 * (so history and live events share one contiguous seq space).
	 */
	history(sessionId: string, options: WebHistoryOptions): Promise<WebHistoryResult>;
	/**
	 * Sends a message after durable admission, switching the attached session
	 * when the target is cold. `rpcId` rides the echoed user message so the
	 * client reconciles its optimistic echo; `mode` maps onto the backend's
	 * streaming delivery (steer interrupts the running turn, queue follows up).
	 */
	prompt(sessionId: string, content: WebPromptPart[], options?: WebPromptOptions): Promise<void>;
	/** Edits, removes, or strictly steers one pending queued message. */
	updateQueue(sessionId: string, itemId: string, action: WebQueueAction): Promise<void>;
	/** @returns the session's pending queue snapshot (the mux baseline). */
	queuedMessages(sessionId: string): Promise<WebQueueItem[]>;
	/** @returns the session's background-job snapshot (the mux baseline). */
	sessionJobs(sessionId: string): Promise<import("./events").WebJobView[]>;
	/** Stops the session's active turn. */
	cancel(sessionId: string): Promise<void>;
	/** Renames a session and announces the title through the subscription stream. */
	rename(sessionId: string, title: string): Promise<{ title: string; seq: number }>;
	/**
	 * Forks a new session from a completed-turn prefix (`session.fork`):
	 * `atSeq` anchors the cut at the first `turn/end` at or after it; omitted
	 * falls back to the last completed turn.
	 */
	fork(sessionId: string, anchor?: { atSeq?: number; entryId?: string }): Promise<{ sessionId: string }>;
	/**
	 * The session's entry tree (`ompHistory/tree`): every entry in TUI `/tree`
	 * display vocabulary, plus whether branch summaries are enabled (the TUI
	 * rewind flow asks about summarization only when they are).
	 */
	historyTree(sessionId: string): Promise<{ nodes: WebHistoryNode[]; branchSummariesEnabled: boolean }>;
	/**
	 * Rewind: move the session onto the path through one entry
	 * (`ompHistory/navigate`). `summarize`/`customInstructions` mirror the TUI
	 * selector's summarize-and-switch choice.
	 */
	navigateToEntry(
		sessionId: string,
		entryId: string,
		options?: { summarize?: boolean; customInstructions?: string },
	): Promise<{ editorText?: string; aborted?: boolean }>;
	/** Sets or clears an entry label (TUI tree Shift+L, `ompHistory/label`). */
	setEntryLabel(sessionId: string, entryId: string, label?: string): Promise<void>;
	/** Reads the advisory model directory for a session. */
	models(sessionId: string): Promise<WebSessionModels>;
	/** Selects the model (and optional reasoning effort) for a session. */
	selectModel(
		sessionId: string,
		selection: { provider: string; model: string; reasoningEffort?: string },
	): Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }>;
	/** Lists the slash-command directory for a session. */
	listCommands(sessionId: string): Promise<WebCommandDescriptor[]>;
	/** Lists the session's user-invocable skill catalog (`skill.list`). */
	listSkills(sessionId: string): Promise<WebSkillEntry[]>;
	/**
	 * Collects the session log download (`GET /api/session.export`): the
	 * session's own JSONL plus, when `includeDescendants`, every session file
	 * in the bucket whose parentSession chain bottoms out at this session.
	 * Undefined when no persisted session carries the id.
	 */
	exportSessionLog(
		sessionId: string,
		includeDescendants: boolean,
	): Promise<{ entries: Array<{ name: string; data: Uint8Array }> } | undefined>;
	/** Executes one slash-command line; undefined when the name is unknown. */
	executeCommand(sessionId: string, line: string): Promise<WebCommandExecution | undefined>;
	/** Host settings facts served by `settings.describe` (M3: document surface only). */
	settingsOverview(): Promise<{ writable: boolean; hasDocument: boolean }>;
	/**
	 * Materialize the settings document when absent and hand it to the
	 * platform text-document opener (`settings.openDocument`).
	 */
	openSettingsDocument(): Promise<void>;
	/** Browser-client settings namespaces (onboarding acks and friends). */
	clientSettingNamespaces(): Promise<Array<{ ns: string; value: Record<string, unknown> }>>;
	/**
	 * Apply path-addressed edits to one browser-client namespace; returns the
	 * new section value (`settings.mutate`/`settings.update`).
	 */
	mutateClientSetting(
		ns: string,
		ops: Array<{ op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] }>,
	): Promise<{ ns: string; value: Record<string, unknown> }>;
	/** The OMP settings catalog (tabs → groups → fields with live values). */
	ompSettingsCatalog(): Promise<import("./omp-settings").WebOmpSettingsCatalog>;
	/** Write one OMP setting by key (typed loosely at the seam; host validates). */
	setOmpSetting(key: string, value: unknown): Promise<void>;
	/** Log out of one provider: clear every stored credential for it (TUI /logout). */
	logoutProvider(provider: string): Promise<void>;
	/**
	 * Assign a model role's target (`model` is the `provider/id` selector with
	 * an optional thinking effort) or clear the role when `selection` is
	 * omitted. Throws when the model is not available.
	 */
	setModelRole(role: string, selection?: { model: string; thinking?: string }): Promise<void>;
	/** One subagent row of the session-header catalog. */
	listSubagents(parentSessionId: string): Promise<{
		entries: Array<{
			id: string;
			/** one-shot: finished single-turn child; continuable: live or parked multi-turn child. */
			mode: "one-shot" | "continuable";
			activity: "running" | "inactive";
			hasChildren: boolean;
			label?: string;
		}>;
		parentAvailable: boolean;
	}>;
	/** Reads a child session's translated history window (`subagent.history`). */
	subagentHistory(
		parentSessionId: string,
		childSessionId: string,
		options: WebHistoryOptions,
	): Promise<WebHistoryResult>;
	/** Sends a user message to one continuable child (`subagent.prompt`). */
	promptSubagent(
		parentSessionId: string,
		childSessionId: string,
		content: WebPromptPart[],
	): Promise<{ messageId: string }>;
	/** Interrupts one continuable child's active turn (`subagent.interrupt`). */
	interruptSubagent(parentSessionId: string, childSessionId: string): Promise<void>;
	/** Creates a goal for the session (`goals/create`); returns its CAS ref. */
	goalCreate(sessionId: string, objective: string): Promise<{ ref: { id: string; revision: number } }>;
	/** Edits the objective of the current goal (`goals/edit`, CAS on `ref`). */
	goalEdit(
		sessionId: string,
		ref: { id: string; revision: number },
		changes: { objective?: string; maxGoalRounds?: number },
	): Promise<import("./events").WebGoalView>;
	/** Pauses the current goal (`goals/pause`, CAS on `ref`). */
	goalPause(sessionId: string, ref: { id: string; revision: number }): Promise<import("./events").WebGoalView>;
	/** Resumes a paused goal (`goals/resume`, CAS on `ref`). */
	goalResume(sessionId: string, ref: { id: string; revision: number }): Promise<import("./events").WebGoalView>;
	/** Marks the current goal complete (`goals/complete`, CAS on `ref`). */
	goalComplete(sessionId: string, ref: { id: string; revision: number }): Promise<import("./events").WebGoalView>;
	/** Clears the goal record (`goals/clear`, CAS on `ref`). */
	goalClear(sessionId: string, ref: { id: string; revision: number }): Promise<{ id: string; revision: number }>;
	/**
	 * `@`-mention file candidates for one query prefix (`fileReferences/list`):
	 * paths relative to the session cwd; directories keep completion open.
	 */
	listFileReferences(sessionId: string, query: string): Promise<Array<{ path: string; kind: "file" | "directory" }>>;
	/** Subscribes to host-pushed stream notifications; returns the unsubscriber. */
	subscribe(listener: (event: WebStreamEvent) => void): () => void;
	/**
	 * Sessions with a live attached agent plus their current event watermark;
	 * the mux stream's `session/subscribed` baseline.
	 */
	attachedSessions(): Promise<Array<{ sessionId: string; lastSeq: number }>>;
}
