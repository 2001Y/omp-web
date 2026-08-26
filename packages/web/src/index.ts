/**
 * @oh-my-pi/web — the web GUI host package.
 *
 * Serves the vendored dsh-web browser stack and bridges its `/api` RPC
 * contract onto an injected {@link WebDriver}. The coding agent's web mode
 * (`packages/coding-agent/src/modes/web/`) is the only implementer of that
 * interface; this package never imports the coding agent.
 */

export type { BootPluginRecord, ComposedBoot, WebBootEntry, WebBootGraph } from "./boot/graph";
export { BOOT_ROSTER, composeBootGraph, orderByModuleGraph, stripClientSuffix } from "./boot/graph";
export type { IndexInjection, IndexInjectionPlacement } from "./boot/inject";
export { bootInjections, renderIndexInjections } from "./boot/inject";
export type {
	ClientRequest,
	ClientResponse,
	RpcError,
	RpcReceipt,
	RpcResult,
	ServerRequest,
	ServerResponse,
} from "./contract/wire";
export { internalError } from "./contract/wire";
export type {
	WebCommandDescriptor,
	WebCommandExecution,
	WebCommandResult,
	WebDriver,
	WebHistoryNode,
	WebHistoryOptions,
	WebHistoryResult,
	WebHostDescription,
	WebModelEntry,
	WebModelProviderGroup,
	WebModelReasoning,
	WebPromptOptions,
	WebPromptPart,
	WebQueueAction,
	WebQueueItem,
	WebReasoningEffort,
	WebSessionModels,
	WebSessionSummary,
	WebSkillEntry,
	WebWorkspace,
} from "./protocol/driver";
export type {
	WebContentBlock,
	WebFinishReason,
	WebGoalPhase,
	WebGoalProjection,
	WebGoalSnapshot,
	WebGoalView,
	WebImageAttachmentRef,
	WebImageBlock,
	WebImageLimits,
	WebImageMediaType,
	WebJobView,
	WebMessage,
	WebMessageSource,
	WebPlanProjection,
	WebReasoningBlock,
	WebSessionEvent,
	WebStreamChunk,
	WebStreamEvent,
	WebTextBlock,
	WebTokenUsage,
	WebToolCallBlock,
	WebToolResultBlock,
	WebTurnEndReason,
} from "./protocol/events";
export type {
	WebApprovalAsk,
	WebApprovalResponseValue,
	WebAskAnswer,
	WebAskOption,
	WebAskOutcome,
	WebAskQuestion,
	WebAskRequest,
	WebQuestionResponseValue,
} from "./protocol/interactions";
export { parseApprovalResponse, parseQuestionResponse } from "./protocol/interactions";
export type {
	WebOmpSettingsCatalog,
	WebSettingField,
	WebSettingGroup,
	WebSettingOption,
	WebSettingTab,
} from "./protocol/omp-settings";
export type { WebServerHandle, WebServerOptions } from "./server/serve";
export { startWebServer } from "./server/serve";
