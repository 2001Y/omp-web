/**
 * Session-event vocabulary of the vendored dsh-web client contract, restated
 * host-neutrally for the {@link WebDriver} seam. Structural mirror of the
 * `SessionEvent` / `Message` / `StreamChunk` unions from
 * `@deepseek-ai/dsh-session/types` + `@deepseek-ai/dsh-llm/types` (subset the
 * omp host emits; see PROVENANCE.md in the omp-web workspace root). The
 * vendored browser bundles remain the authoritative shapes.
 */

/** Visible text content block. */
export interface WebTextBlock {
	type: "text";
	text: string;
}

/** Reasoning / thinking content block, distinct from visible text. */
export interface WebReasoningBlock {
	type: "reasoning";
	text: string;
}

/** A tool invocation requested by the model (raw JSON arguments string). */
export interface WebToolCallBlock {
	type: "tool-call";
	id: string;
	name: string;
	arguments: string;
}

/** The result of one tool invocation, sent back to the model. */
export interface WebToolResultBlock {
	type: "tool-result";
	toolCallId: string;
	content: WebContentBlock[];
	isError?: boolean;
}

/** Raster image media types accepted by the browser wire (dsh v1 vocabulary). */
export type WebImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * Durable image reference. The bytes never ride the event log; the client
 * fetches them through `session.attachment` against the attachmentId (the
 * omp host derives ids as content hashes, so history replay and live events
 * resolve identically without a separate store).
 */
export interface WebImageAttachmentRef {
	attachmentId: string;
	mediaType: WebImageMediaType;
	bytes: number;
	width: number;
	height: number;
	name?: string;
}

/** Image content block (prompt upload, durable history, tool-result payload). */
export interface WebImageBlock {
	type: "image";
	attachment: WebImageAttachmentRef;
}

/** Content-block union the omp host emits. */
export type WebContentBlock = WebTextBlock | WebReasoningBlock | WebToolCallBlock | WebToolResultBlock | WebImageBlock;

/** Token accounting for one model call. */
export interface WebTokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

/** Why a model response stopped. */
export type WebFinishReason =
	| { kind: "stop" }
	| { kind: "tool-calls" }
	| { kind: "max-tokens" }
	| { kind: "aborted"; failure: { message: string; code: string } }
	| { kind: "error"; failure: { message: string; code: string } };

/** Raw streaming protocol (subset; indexes correlate interleaved deltas). */
export type WebStreamChunk =
	| { type: "block-start"; index: number; blockType: "text" | "reasoning" }
	| { type: "text-delta"; index: number; text: string }
	| { type: "reasoning-delta"; index: number; text: string }
	| { type: "block-end"; index: number; block: WebTextBlock | WebReasoningBlock }
	| { type: "finish"; reason: WebFinishReason };

/** Source of a user-role message; `rpcId` mirrors the dsh contract field (the client treats it as opaque). */
export interface WebUserMessageSource {
	kind: "user";
	rpcId?: string;
}

/** Source of a model-produced assistant message. */
export interface WebModelMessageSource {
	kind: "model";
	provider: string;
	model: string;
}

/** Source of a user-role message carrying one tool result. */
export interface WebToolMessageSource {
	kind: "tool";
	callId: string;
}

export type WebMessageSource = WebUserMessageSource | WebModelMessageSource | WebToolMessageSource;

/** One immutable message representation (role-union the omp host emits). */
export interface WebMessage {
	id: string;
	role: "user" | "assistant";
	content: WebContentBlock[];
	source: WebMessageSource;
}

/** Why a turn ended. */
export type WebTurnEndReason =
	| { kind: "completed" }
	| { kind: "aborted"; cause: { kind: "user" } }
	| { kind: "error"; error: { message: string; code: string } }
	| { kind: "max-tokens" }
	| { kind: "interrupted" };

/**
 * One entry in the session event log. Surface events (`user/message`,
 * `assistant/message`, `tool/result`) carry `surfaceOp: "append"`; the
 * omp host never emits compaction replaces.
 */
export type WebSessionEvent =
	| { type: "turn/start"; seq: number; time: number; data: { turn: number } }
	| { type: "turn/end"; seq: number; time: number; data: { turn: number; reason: WebTurnEndReason } }
	| { type: "step/start"; seq: number; time: number; data: { turn: number; step: number } }
	| { type: "step/end"; seq: number; time: number; data: { turn: number; step: number } }
	| {
			type: "user/message";
			seq: number;
			time: number;
			surfaceOp: "append";
			data: WebMessage;
	  }
	| {
			type: "assistant/chunk";
			seq: number;
			time: number;
			data: { turn: number; step: number; chunk: WebStreamChunk };
	  }
	| {
			type: "assistant/message";
			seq: number;
			time: number;
			surfaceOp: "append";
			data: { turn: number; step: number; message: WebMessage; usage?: WebTokenUsage; interrupted?: true };
	  }
	| {
			type: "tool/call";
			seq: number;
			time: number;
			data: { turn: number; step: number; callId: string; name: string; arguments: string };
	  }
	| {
			type: "tool/result";
			seq: number;
			time: number;
			surfaceOp: "append";
			data: { turn: number; step: number; message: WebMessage };
	  }
	| {
			type: "command/run";
			seq: number;
			time: number;
			data: { commandId: string; name: string; args?: string; source: { kind: "user" } };
	  }
	| {
			type: "command/done";
			seq: number;
			time: number;
			data: {
				commandId: string;
				kind: "success" | "error";
				text?: string;
				sourceEventSeq?: number;
			};
	  }
	| { type: "plan/mode"; seq: number; time: number; data: { active: boolean } }
	| { type: "session/title"; seq: number; time: number; ignorable: true; data: { title: string } };

/** The plan collaboration projection (the `plan` projection-key value). */
export interface WebPlanProjection {
	active: boolean;
	pending: boolean;
}

/** Durable goal lifecycle phase (the dsh goal domain vocabulary). */
export type WebGoalPhase = "active" | "paused" | "blocked" | "complete";

/** One durable goal snapshot (the dsh GoalSnapshot mirror). */
export interface WebGoalSnapshot {
	/** Stable goal identity. */
	id: string;
	/** Positive revision; every durable mutation increments it (CAS anchor). */
	revision: number;
	objective: string;
	phase: WebGoalPhase;
	/** Present exactly while `phase` is `blocked`. */
	blockedReason?: { code: string; message: string };
	/** Round cap; 0 when the backend has no round concept (omp budgets tokens). */
	maxGoalRounds: number;
}

/** The `goal` projection value (dsh GoalProjection mirror). */
export interface WebGoalProjection {
	goal: WebGoalSnapshot;
	roundsStarted: number;
	createdAt: number;
	updatedAt: number;
}

/** One settled goal view (the dsh GoalView mirror: projection + activation). */
export interface WebGoalView extends WebGoalProjection {
	activation: "armed" | "disarmed";
}

/** Deployment image-intake limits (the `imageLimits` projection value). */
export interface WebImageLimits {
	maxImageBytes: number;
	maxImagesPerMessage: number;
	maxMessageImageBytes: number;
	maxImagePixels: number;
	maxImageDimension: number;
	mediaTypes: WebImageMediaType[];
}

/** One background-job row (the dsh JobView wire mirror). */
export interface WebJobView {
	id: string;
	/** Open string: producers extend the kind vocabulary. */
	kind: string;
	label: string;
	status: "running" | "stopping" | "completed" | "killed" | "failed";
	detail?: string;
	startedAt: number;
	finishedAt?: number;
}

/** Host-pushed stream notifications crossing the driver seam. */
export type WebStreamEvent =
	| { kind: "session-event"; sessionId: string; event: WebSessionEvent }
	| { kind: "session-projection"; sessionId: string; key: "title"; value: string; seq: number }
	| {
			kind: "session-projection";
			sessionId: string;
			key: "plan";
			value: WebPlanProjection;
			seq: number;
	  }
	| {
			kind: "session-projection";
			sessionId: string;
			key: "goal";
			value: WebGoalProjection | null;
			seq: number;
	  }
	| {
			/** Constant per boot; re-seeded on every attach baseline. */
			kind: "session-projection";
			sessionId: string;
			key: "imageLimits";
			value: WebImageLimits;
			seq: number;
	  }
	| { kind: "session-added"; sessionId: string; blank: boolean; cwd?: string }
	| { kind: "session-status"; sessionId: string; running: boolean }
	| { kind: "session-jobs"; sessionId: string; jobs: WebJobView[] }
	| {
			kind: "session-queue";
			sessionId: string;
			items: import("./driver").WebQueueItem[];
	  }
	| { kind: "commands-changed" }
	| {
			/**
			 * The attached window moved to another session (switch or new):
			 * the client re-baselines that session (its `session/subscribed`
			 * anchor) and installs the queue snapshot that follows.
			 */
			kind: "session-attached";
			sessionId: string;
			lastSeq: number;
			queue: import("./driver").WebQueueItem[];
			/** Non-empty job baseline follows the subscribed anchor, mirroring the queue. */
			jobs?: WebJobView[];
	  }
	| {
			/** Settle every pending ask of the session as rejected/cancelled (abort, rewind, switch). */
			kind: "cancel-asks";
			sessionId: string;
			reason: string;
	  }
	| {
			kind: "ask-requested";
			sessionId: string;
			rpcId: string;
			request: import("./interactions").WebAskRequest;
			settle: (outcome: import("./interactions").WebAskOutcome) => void;
			fail: (error: Error) => void;
	  };
