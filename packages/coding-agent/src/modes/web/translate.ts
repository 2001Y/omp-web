/**
 * Translation from the OMP agent/session event stream and message history
 * onto the web client's session-event vocabulary (`WebSessionEvent` from
 * `@oh-my-pi/web`, mirroring the vendored dsh-web contract). Pure data
 * adaptation — the additive web fork's OMP-side half of the seam.
 *
 * Live stream: one {@link SessionEventTranslator} per attached session folds
 * `AgentSessionEvent`s into append-only wire events with a monotonic seq.
 * History: the same folding rules run over a persisted `AgentMessage[]` so a
 * cold session reconstructs to the identical shape.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import type {
	WebContentBlock,
	WebImageAttachmentRef,
	WebMessage,
	WebSessionEvent,
	WebStreamChunk,
	WebTurnEndReason,
} from "@oh-my-pi/web";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import type { FileEntry } from "../../session/session-entries";
import { attachmentRefOf } from "./attachments";

/** Distributive Omit so the pending-event type keeps its discriminated union. */
type WithoutSeqTime<E> = E extends unknown ? Omit<E, "seq" | "time"> : never;

/** Map one OMP assistant content block onto the wire vocabulary. */
function mapContentBlock(block: AssistantMessage["content"][number]): WebContentBlock[] {
	switch (block.type) {
		case "text":
			return [{ type: "text", text: block.text }];
		case "thinking":
			return [{ type: "reasoning", text: block.thinking }];
		case "redactedThinking":
			// The data is a provider-opaque encrypted blob, not renderable text;
			// surfacing it as reasoning would print base64 noise.
			return [];
		case "toolCall":
			return [{ type: "tool-call", id: block.id, name: block.name, arguments: JSON.stringify(block.arguments) }];
		case "image": {
			const ref = attachmentRefOf(block.mimeType, block.data);
			return ref === undefined ? [] : [{ type: "image", attachment: ref as WebImageAttachmentRef }];
		}
		// Provider-opaque fallback/server-tool blocks have no wire seat; dropping
		// them keeps the surface lossless elsewhere.
		default:
			return [];
	}
}

/** Map user content (string or block array) onto text and image blocks. */
function mapUserContent(content: UserMessage["content"]): WebContentBlock[] {
	if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
	return content.flatMap((block): WebContentBlock[] => {
		if (block.type === "text") return [{ type: "text", text: block.text }];
		const ref = attachmentRefOf(block.mimeType, block.data);
		return ref === undefined ? [] : [{ type: "image", attachment: ref as WebImageAttachmentRef }];
	});
}

/** Map an OMP assistant message onto the wire message. */
export function mapAssistantMessage(message: AssistantMessage): WebMessage {
	const content = message.content.flatMap(mapContentBlock);
	return {
		id: crypto.randomUUID(),
		role: "assistant",
		content,
		source: { kind: "model", provider: message.provider, model: message.model },
	};
}

/** Map an OMP user message onto the wire message. */
export function mapUserMessage(message: UserMessage): WebMessage {
	return {
		id: crypto.randomUUID(),
		role: "user",
		content: mapUserContent(message.content),
		source: { kind: "user" },
	};
}

/**
 * Disambiguate an OMP tool-call id onto the wire: OMP synthesizes per-tool
 * ids (`ollama:1:read`) that repeat across steps, while the wire contract
 * requires session-unique call correlation. The turn/step qualifier is
 * deterministic on both the call and the result side.
 */
function wireCallId(id: string, turn: number, step: number): string {
	return `${id}@t${turn}s${step}`;
}

/** Map an OMP tool-result message onto the wire tool-result message. */
export function mapToolResultMessage(message: ToolResultMessage, callId: string): WebMessage {
	const content = message.content.flatMap((block): WebContentBlock[] => {
		if (block.type === "text") return [{ type: "text", text: block.text }];
		const ref = attachmentRefOf(block.mimeType, block.data);
		return ref === undefined ? [] : [{ type: "image", attachment: ref as WebImageAttachmentRef }];
	});
	return {
		id: crypto.randomUUID(),
		role: "user",
		content: [
			{
				type: "tool-result",
				toolCallId: callId,
				content: content.length > 0 ? content : [{ type: "text", text: "" }],
				...(message.isError ? { isError: true } : {}),
			},
		],
		source: { kind: "tool", callId },
	};
}

/** Map the assistant message's stop reason onto a wire turn-end reason. */
function mapTurnEndReason(message: AgentMessage | undefined): WebTurnEndReason {
	const assistant = message as AssistantMessage | undefined;
	switch (assistant?.stopReason) {
		case "length":
			return { kind: "max-tokens" };
		case "aborted":
			return { kind: "aborted", cause: { kind: "user" } };
		case "error":
			return { kind: "error", error: { message: assistant.errorMessage ?? "provider error", code: "UNKNOWN" } };
		default:
			return { kind: "completed" };
	}
}

/**
 * One persisted omp-web command lifecycle record (the `omp-web/command`
 * custom entry's data): a run half, or the done half settling it.
 */
export interface WebCommandRecord {
	phase: "run" | "done";
	commandId: string;
	name?: string;
	args?: string;
	kind?: "success" | "error";
	text?: string;
}

/** The custom entry type carrying {@link WebCommandRecord}s in the session file. */
export const COMMAND_ENTRY_TYPE = "omp-web/command";

/** Narrow one custom entry onto a command record, or undefined. */
export function commandRecordOf(entry: {
	type: string;
	customType?: string;
	data?: unknown;
}): WebCommandRecord | undefined {
	if (entry.type !== "custom" || entry.customType !== COMMAND_ENTRY_TYPE) return undefined;
	const data = entry.data;
	if (typeof data !== "object" || data === null) return undefined;
	const record = data as Record<string, unknown>;
	if (record.phase !== "run" && record.phase !== "done") return undefined;
	if (typeof record.commandId !== "string") return undefined;
	return {
		phase: record.phase,
		commandId: record.commandId,
		...(typeof record.name === "string" ? { name: record.name } : {}),
		...(typeof record.args === "string" ? { args: record.args } : {}),
		...(record.kind === "success" || record.kind === "error" ? { kind: record.kind } : {}),
		...(typeof record.text === "string" ? { text: record.text } : {}),
	};
}

/** One interleaved history fold unit: a persisted message, command record, or plan flip. */
export type HistoryItem =
	| { kind: "message"; message: AgentMessage }
	| { kind: "command"; record: WebCommandRecord; time: number }
	| { kind: "plan-mode"; active: boolean; time: number };

/** Tool calls of an assistant message in wire block form. */
function toolCallsOf(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

/**
 * One session's live folding state. Counts turns and steps, mints monotonic
 * seq numbers, and converts each incoming event into zero or more wire events.
 */
export class SessionEventTranslator {
	#seq = -1;
	#turn = -1;
	#step = -1;
	#turnOpen = false;
	#stepOpen = false;
	#log: WebSessionEvent[] = [];

	/** Mint the next seq. */
	nextSeq(): number {
		return ++this.#seq;
	}

	/** Current watermark (last minted seq; -1 for an empty log). */
	get lastSeq(): number {
		return this.#seq;
	}

	/**
	 * Jump the seq watermark forward (display-log epoch splice): after a
	 * rewind reseed, the next minted event lands past every seq any client
	 * has seen. The forward gap makes the client's live-ingestion repair
	 * refetch the tail page — the one no-client-change path whose window
	 * replace rebuilds a resident conversation after a rewind.
	 * @param seq - the new watermark floor.
	 */
	skipTo(seq: number): void {
		if (seq > this.#seq) this.#seq = seq;
	}

	/**
	 * The canonical event log this translator has produced (history seed plus
	 * live appends). The attached session's `session.history` serves from it,
	 * so history and live events share ONE contiguous seq space per epoch.
	 */
	get log(): readonly WebSessionEvent[] {
		return this.#log;
	}

	/** Reset every counter and the log (start of an attachment epoch). */
	reset(): void {
		this.#seq = -1;
		this.#turn = -1;
		this.#step = -1;
		this.#turnOpen = false;
		this.#stepOpen = false;
		this.#log = [];
	}

	/**
	 * Seed an attachment epoch: fold the session's persisted messages into
	 * the canonical log so live events continue its seq space without a gap
	 * (a gap would make the client drop the first live events as replay).
	 */
	adopt(messages: readonly AgentMessage[]): void {
		this.reset();
		this.translateHistory(messages);
	}

	/**
	 * Seed an attachment epoch from the raw entry list, interleaving persisted
	 * command records with message history at their original positions.
	 */
	adoptEntries(entries: ReadonlyArray<FileEntry>): void {
		this.reset();
		// /clear parity: emission starts after the latest reset_boundary so a
		// reseed does not resurrect the pre-reset conversation (TUI rebuild rule).
		let cut = 0;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i].type === "reset_boundary") {
				cut = i + 1;
				break;
			}
		}
		const items: HistoryItem[] = [];
		for (const entry of entries.slice(cut)) {
			if (entry.type === "message") {
				items.push({ kind: "message", message: entry.message });
			} else if (entry.type === "mode_change") {
				// Persisted mode flips fold to plan/mode events (the only mode the
				// web vocabulary carries); `none` clears it, anything else is skipped.
				if (entry.mode === "plan")
					items.push({ kind: "plan-mode", active: true, time: Date.parse(entry.timestamp) });
				else if (entry.mode === "none" && items.some(item => item.kind === "plan-mode")) {
					items.push({ kind: "plan-mode", active: false, time: Date.parse(entry.timestamp) });
				}
			} else {
				const record = commandRecordOf(entry);
				if (record !== undefined) {
					const time = Number.isNaN(Date.parse(entry.timestamp)) ? Date.now() : Date.parse(entry.timestamp);
					items.push({ kind: "command", record, time });
				}
			}
		}
		this.translateItems(items);
	}

	/** Append one synthetic plan-mode flip (mints seq; the plan bridge). */
	appendPlanMode(active: boolean): WebSessionEvent {
		const event = {
			type: "plan/mode",
			seq: this.nextSeq(),
			time: Date.now(),
			data: { active },
		} as WebSessionEvent;
		this.#log.push(event);
		return event;
	}

	/** Append one synthetic command-run event (mints seq; live command bridge). */
	appendCommandRun(commandId: string, name: string, args: string): WebSessionEvent {
		const event = {
			type: "command/run",
			seq: this.nextSeq(),
			time: Date.now(),
			data: {
				commandId,
				name,
				...(args === "" ? {} : { args }),
				source: { kind: "user" },
			},
		} as WebSessionEvent;
		this.#log.push(event);
		return event;
	}

	/** Append one synthetic command-done event settling its run. */
	appendCommandDone(commandId: string, kind: "success" | "error", text?: string): WebSessionEvent {
		const event = {
			type: "command/done",
			seq: this.nextSeq(),
			time: Date.now(),
			data: {
				commandId,
				kind,
				...(text !== undefined && text !== "" ? { text } : {}),
			},
		} as WebSessionEvent;
		this.#log.push(event);
		return event;
	}

	/** Fold one live agent event into wire events. */
	translate(event: AgentSessionEvent): WebSessionEvent[] {
		const out: WebSessionEvent[] = [];
		const push = (wire: WithoutSeqTime<WebSessionEvent>): void => {
			const event = { ...wire, seq: this.nextSeq(), time: Date.now() } as WebSessionEvent;
			out.push(event);
			this.#log.push(event);
		};
		const turn = (): number => Math.max(this.#turn, 0);
		const step = (): number => Math.max(this.#step, 0);
		const closeStep = (): void => {
			if (!this.#stepOpen) return;
			this.#stepOpen = false;
			push({ type: "step/end", data: { turn: turn(), step: step() } });
		};

		switch (event.type) {
			case "turn_start":
				closeStep();
				if (this.#turnOpen) push({ type: "turn/end", data: { turn: turn(), reason: { kind: "completed" } } });
				this.#turn++;
				this.#turnOpen = true;
				push({ type: "turn/start", data: { turn: this.#turn } });
				break;
			case "turn_end":
				closeStep();
				if (this.#turnOpen) {
					this.#turnOpen = false;
					push({ type: "turn/end", data: { turn: turn(), reason: mapTurnEndReason(event.message) } });
				}
				break;
			case "message_start": {
				const message = event.message;
				if (message.role === "assistant") {
					if (this.#stepOpen) closeStep();
					if (!this.#turnOpen) {
						this.#turn++;
						this.#turnOpen = true;
						push({ type: "turn/start", data: { turn: this.#turn } });
					}
					this.#step++;
					this.#stepOpen = true;
					push({ type: "step/start", data: { turn: turn(), step: this.#step } });
				} else if (message.role === "user") {
					// Steering messages are user-authored turns too — the TUI renders
					// them, and dropping them would make the user's interruption
					// vanish from the transcript (the queue chip is gone by then).
					if (!this.#turnOpen) {
						this.#turn++;
						this.#turnOpen = true;
						push({ type: "turn/start", data: { turn: this.#turn } });
					}
					push({ type: "user/message", surfaceOp: "append", data: mapUserMessage(message) });
				}
				break;
			}
			case "message_update": {
				const message = event.message;
				if (message.role !== "assistant") break;
				const chunk = mapStreamChunk(event.assistantMessageEvent);
				if (chunk !== undefined) push({ type: "assistant/chunk", data: { turn: turn(), step: step(), chunk } });
				break;
			}
			case "message_end": {
				const message = event.message;
				if (message.role === "assistant") {
					const wire = mapAssistantMessage(message);
					// An aborted/empty model response carries no wire assistant message
					// (the dsh contract: an aborted turn with no streamed content has
					// no such event); the turn/end reason carries the outcome.
					if (wire.content.length === 0) break;
					push({
						type: "assistant/message",
						surfaceOp: "append",
						data: {
							turn: turn(),
							step: step(),
							message: wire,
							usage: {
								inputTokens: message.usage.input,
								outputTokens: message.usage.output,
								...(message.usage.cacheRead > 0 ? { cacheReadTokens: message.usage.cacheRead } : {}),
								...(message.usage.cacheWrite > 0 ? { cacheWriteTokens: message.usage.cacheWrite } : {}),
							},
						},
					});
					for (const call of toolCallsOf(message)) {
						push({
							type: "tool/call",
							data: {
								turn: turn(),
								step: step(),
								callId: wireCallId(call.id, turn(), step()),
								name: call.name,
								arguments: JSON.stringify(call.arguments),
							},
						});
					}
				} else if (message.role === "toolResult") {
					push({
						type: "tool/result",
						surfaceOp: "append",
						data: {
							turn: turn(),
							step: step(),
							message: mapToolResultMessage(message, wireCallId(message.toolCallId, turn(), step())),
						},
					});
				}
				break;
			}
			default:
				// Tool-execution lifecycles surface through the toolResult message
				// events; session-level notices have no M1 wire seat.
				break;
		}
		return out;
	}

	/** Fold a persisted message list into the same wire shape (history read). */
	translateHistory(messages: readonly AgentMessage[]): WebSessionEvent[] {
		return this.translateItems(messages.map(message => ({ kind: "message", message })));
	}

	/** Fold one interleaved history item (message or persisted command record). */
	translateItems(items: readonly HistoryItem[]): WebSessionEvent[] {
		const out: WebSessionEvent[] = [];
		const push = (wire: WithoutSeqTime<WebSessionEvent>, time: number): void => {
			const event = { ...wire, seq: this.nextSeq(), time } as WebSessionEvent;
			out.push(event);
			this.#log.push(event);
		};
		let sawAssistantInTurn = false;
		const closeStep = (time: number): void => {
			if (!this.#stepOpen) return;
			this.#stepOpen = false;
			push({ type: "step/end", data: { turn: Math.max(this.#turn, 0), step: Math.max(this.#step, 0) } }, time);
		};
		for (const item of items) {
			if (item.kind === "command") {
				const record = item.record;
				if (record.phase === "run" && record.name !== undefined) {
					push(
						{
							type: "command/run",
							data: {
								commandId: record.commandId,
								name: record.name,
								...(record.args === undefined || record.args === "" ? {} : { args: record.args }),
								source: { kind: "user" },
							},
						},
						item.time,
					);
				} else if (record.phase === "done") {
					push(
						{
							type: "command/done",
							data: {
								commandId: record.commandId,
								kind: record.kind ?? "success",
								...(record.text === undefined || record.text === "" ? {} : { text: record.text }),
							},
						},
						item.time,
					);
				}
				continue;
			}
			if (item.kind === "plan-mode") {
				push({ type: "plan/mode", data: { active: item.active } }, item.time);
				continue;
			}
			const message = item.message;
			const time = message.timestamp;
			if (message.role === "user") {
				// Same rule as the live path: steering messages are real user turns.
				if (this.#turnOpen && sawAssistantInTurn) {
					closeStep(time);
					this.#turnOpen = false;
					push({ type: "turn/end", data: { turn: Math.max(this.#turn, 0), reason: { kind: "completed" } } }, time);
				}
				if (!this.#turnOpen) {
					this.#turn++;
					this.#turnOpen = true;
					sawAssistantInTurn = false;
					push({ type: "turn/start", data: { turn: this.#turn } }, time);
				}
				push({ type: "user/message", surfaceOp: "append", data: mapUserMessage(message) }, time);
			} else if (message.role === "assistant") {
				if (this.#stepOpen) closeStep(time);
				if (!this.#turnOpen) {
					this.#turn++;
					this.#turnOpen = true;
					push({ type: "turn/start", data: { turn: this.#turn } }, time);
				}
				sawAssistantInTurn = true;
				this.#step++;
				this.#stepOpen = true;
				push({ type: "step/start", data: { turn: this.#turn, step: this.#step } }, time);
				const wireMessage = mapAssistantMessage(message);
				// Same empty-response rule as the live path: no content, no event.
				if (wireMessage.content.length > 0) {
					push(
						{
							type: "assistant/message",
							surfaceOp: "append",
							data: {
								turn: this.#turn,
								step: this.#step,
								message: wireMessage,
								usage: {
									inputTokens: message.usage.input,
									outputTokens: message.usage.output,
									...(message.usage.cacheRead > 0 ? { cacheReadTokens: message.usage.cacheRead } : {}),
									...(message.usage.cacheWrite > 0 ? { cacheWriteTokens: message.usage.cacheWrite } : {}),
								},
							},
						},
						time,
					);
					for (const call of toolCallsOf(message)) {
						push(
							{
								type: "tool/call",
								data: {
									turn: this.#turn,
									step: this.#step,
									callId: wireCallId(call.id, this.#turn, this.#step),
									name: call.name,
									arguments: JSON.stringify(call.arguments),
								},
							},
							time,
						);
					}
				}
			} else if (message.role === "toolResult") {
				push(
					{
						type: "tool/result",
						surfaceOp: "append",
						data: {
							turn: Math.max(this.#turn, 0),
							step: Math.max(this.#step, 0),
							message: mapToolResultMessage(
								message,
								wireCallId(message.toolCallId, Math.max(this.#turn, 0), Math.max(this.#step, 0)),
							),
						},
					},
					time,
				);
			}
		}
		if (this.#turnOpen) {
			const last = items.at(-1);
			const time = last !== undefined && last.kind === "message" ? last.message.timestamp : Date.now();
			closeStep(time);
			this.#turnOpen = false;
			push(
				{
					type: "turn/end",
					data: {
						turn: Math.max(this.#turn, 0),
						reason: mapTurnEndReason(
							items
								.filter((item): item is { kind: "message"; message: AgentMessage } => item.kind === "message")
								.findLast(item => item.message.role === "assistant")?.message,
						),
					},
				},
				time,
			);
		}
		return out;
	}
}

/** Map one streaming assistant-event delta onto a wire chunk (M1: text/reasoning). */
function mapStreamChunk(event: AssistantMessageEvent): WebStreamChunk | undefined {
	switch (event.type) {
		case "text_start":
			return { type: "block-start", index: event.contentIndex, blockType: "text" };
		case "text_delta":
			return { type: "text-delta", index: event.contentIndex, text: event.delta };
		case "text_end":
			return { type: "block-end", index: event.contentIndex, block: { type: "text", text: event.content } };
		case "thinking_start":
			return { type: "block-start", index: event.contentIndex, blockType: "reasoning" };
		case "thinking_delta":
			return { type: "reasoning-delta", index: event.contentIndex, text: event.delta };
		case "thinking_end":
			return { type: "block-end", index: event.contentIndex, block: { type: "reasoning", text: event.content } };
		default:
			return undefined;
	}
}
