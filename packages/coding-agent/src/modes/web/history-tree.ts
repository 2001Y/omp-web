/**
 * Session-entry → History-view node projection (TUI `/tree` parity).
 *
 * The web History view renders with the same display vocabulary the TUI tree
 * selector builds in `modes/components/tree-selector.ts`: one node per entry
 * (any type), a value string per the TUI's `#getEntryDisplayText`, and the
 * filter flags its filter modes key off. Role prefixes stay client-side so the
 * GUI can localize them; tool summaries stay server-side because they need the
 * assistant-side tool-call index.
 */

import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { WebHistoryNode } from "@oh-my-pi/web";
import type { SessionEntry } from "../../session/session-entries";
import { shortenPath, toPathList } from "@oh-my-pi/pi-tui/render/render-utils";
import { canonicalizeMessage } from "@oh-my-pi/pi-tui/chat/thinking-display";
import { resolveAssistantErrorPresentation } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";

/** The text budget the TUI applies to tree-row content. */
const MAX_TEXT = 200;

type NormalizedNode = Omit<WebHistoryNode, "timestamp" | "onCurrentPath" | "currentLeaf">;

function normalize(text: string): string {
	return text.replace(/[\n\t]/g, " ").trim();
}

/** Concatenated text blocks of a message content (string or block array). */
function contentText(content: unknown): string {
	if (typeof content === "string") return content.slice(0, MAX_TEXT);
	if (!Array.isArray(content)) return "";
	let result = "";
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
			result += (block as { text: string }).text;
			if (result.length >= MAX_TEXT) return result.slice(0, MAX_TEXT);
		}
	}
	return result;
}

/** Non-whitespace text present after thinking-tag canonicalization (TUI #hasTextContent). */
function hasTextContent(content: unknown): boolean {
	if (typeof content === "string") return canonicalizeMessage(content).length > 0;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (typeof block === "object" && block !== null && (block as { type?: string }).type === "text") {
			if (canonicalizeMessage((block as { text?: string }).text ?? "")) return true;
		}
	}
	return false;
}

/** Tool summary in the TUI's tree vocabulary (`read: path:1-10`). */
function formatToolCall(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "read": {
			const path = shortenPath(String(args.path ?? args.file_path ?? ""));
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let display = path;
			if (offset !== undefined || limit !== undefined) {
				const start = offset ?? 1;
				const end = limit !== undefined ? start + limit - 1 : "";
				display += `:${start}${end ? `-${end}` : ""}`;
			}
			return `read: ${display}`;
		}
		case "write":
			return `write: ${shortenPath(String(args.path ?? args.file_path ?? ""))}`;
		case "edit":
			return `edit: ${shortenPath(String(args.path ?? args.file_path ?? ""))}`;
		case "bash": {
			const raw = String(args.command ?? "");
			const cmd = normalize(raw).slice(0, 50);
			return `bash: ${cmd}${raw.length > 50 ? "..." : ""}`;
		}
		case "grep": {
			const pattern = String(args.pattern ?? "");
			const input =
				typeof args.paths === "string" || Array.isArray(args.paths)
					? args.paths
					: typeof args.path === "string"
						? args.path
						: undefined;
			const paths = toPathList(input);
			return `grep: /${pattern}/ in ${shortenPath(paths.length > 0 ? paths.join(", ") : ".")}`;
		}
		case "glob": {
			const input =
				typeof args.path === "string"
					? args.path
					: typeof args.paths === "string" || Array.isArray(args.paths)
						? args.paths
						: undefined;
			const paths = toPathList(input);
			return `glob: ${shortenPath(paths.length > 0 ? paths.join(", ") : ".")}`;
		}
		case "ls":
			return `ls: ${shortenPath(String(args.path ?? "."))}`;
		default: {
			const argsStr = JSON.stringify(args);
			return `${name}: ${argsStr.slice(0, 40)}${argsStr.length > 40 ? "..." : ""}`;
		}
	}
}

/**
 * Project one entry into its History-node vocabulary (path/leaf fields are
 * blended in by the caller, who owns the current-leaf walk).
 */
export function describeHistoryEntry(
	entry: SessionEntry,
	toolCalls: ReadonlyMap<string, { name: string; arguments: Record<string, unknown> }>,
): NormalizedNode {
	const base = { id: entry.id, parentId: entry.parentId };
	if (entry.type === "message") {
		const message = entry.message as AgentMessage;
		const content = (message as { content?: unknown }).content;
		switch (message.role) {
			case "user":
				return {
					...base,
					kind: "user",
					text: normalize(contentText(content)),
					bookkeeping: false,
					toolCallsOnly: false,
					errorOrAborted: false,
				};
			case "developer":
				return {
					...base,
					kind: "developer",
					text: normalize(contentText(content)),
					bookkeeping: false,
					toolCallsOnly: false,
					errorOrAborted: false,
				};
			case "assistant": {
				const presentation = resolveAssistantErrorPresentation(message);
				if (presentation.kind === "compact-recovered") {
					return {
						...base,
						kind: "assistant",
						text: normalize(presentation.text),
						bookkeeping: false,
						toolCallsOnly: false,
						errorOrAborted: false,
					};
				}
				const textContent = normalize(contentText(content));
				if (textContent !== "") {
					return {
						...base,
						kind: "assistant",
						text: textContent,
						bookkeeping: false,
						toolCallsOnly: false,
						errorOrAborted: false,
					};
				}
				if (presentation.kind === "full") {
					return {
						...base,
						kind: "assistant",
						text: normalize(presentation.text).slice(0, 80),
						bookkeeping: false,
						toolCallsOnly: false,
						errorOrAborted: true,
					};
				}
				if ((message as { stopReason?: string }).stopReason === "aborted") {
					return {
						...base,
						kind: "assistant",
						text: "",
						bookkeeping: false,
						toolCallsOnly: false,
						errorOrAborted: true,
					};
				}
				// Tool-call-only assistant: hidden by the default filter unless it
				// is the leaf (TUI keeps the active position visible).
				return {
					...base,
					kind: "assistant",
					text: "",
					bookkeeping: false,
					toolCallsOnly: !hasTextContent(content),
					errorOrAborted: false,
				};
			}
			case "toolResult": {
				const toolMessage = message as { toolCallId?: string; toolName?: string };
				const call = toolMessage.toolCallId !== undefined ? toolCalls.get(toolMessage.toolCallId) : undefined;
				return {
					...base,
					kind: "toolResult",
					text: call !== undefined ? formatToolCall(call.name, call.arguments) : (toolMessage.toolName ?? "tool"),
					bookkeeping: false,
					toolCallsOnly: false,
					errorOrAborted: false,
				};
			}
			case "bashExecution":
				return {
					...base,
					kind: "bashExecution",
					text: normalize(String((message as { command?: string }).command ?? "")),
					bookkeeping: false,
					toolCallsOnly: false,
					errorOrAborted: false,
				};
			default:
				return {
					...base,
					kind: "customMessage",
					text: String(message.role),
					bookkeeping: false,
					toolCallsOnly: false,
					errorOrAborted: false,
				};
		}
	}
	switch (entry.type) {
		case "custom_message":
			return {
				...base,
				kind: "customMessage",
				text: `${entry.customType}: ${normalize(typeof entry.content === "string" ? entry.content : contentText(entry.content))}`,
				bookkeeping: false,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "compaction":
			return {
				...base,
				kind: "compaction",
				text: `${Math.round(entry.tokensBefore / 1000)}k`,
				bookkeeping: false,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "branch_summary":
			return {
				...base,
				kind: "branchSummary",
				text: normalize(entry.summary),
				bookkeeping: false,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "model_change":
			return {
				...base,
				kind: "modelChange",
				text: entry.model,
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "thinking_level_change":
			return {
				...base,
				kind: "thinkingLevelChange",
				text: entry.thinkingLevel ?? "off",
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "service_tier_change": {
			const tiers = entry.serviceTier
				? Object.entries(entry.serviceTier)
						.map(([family, tier]) => `${family}:${tier}`)
						.join(" ")
				: "";
			return {
				...base,
				kind: "serviceTierChange",
				text: tiers,
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		}
		case "title_change":
			return {
				...base,
				kind: "titleChange",
				text: normalize(entry.title),
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "mode_change":
			return {
				...base,
				kind: "modeChange",
				text: entry.mode,
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "credential_pin":
			return {
				...base,
				kind: "credentialPin",
				text: entry.provider,
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "ttsr_injection":
			return {
				...base,
				kind: "ttsrInjection",
				text: entry.injectedRules.join(" "),
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "model_usage":
			return {
				...base,
				kind: "modelUsage",
				text: entry.model,
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "reset_boundary":
			return {
				...base,
				kind: "resetBoundary",
				text: "",
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "session_init":
			return {
				...base,
				kind: "sessionInit",
				text: "",
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "custom":
			return {
				...base,
				kind: "custom",
				text: entry.customType,
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
		case "label":
			return {
				...base,
				kind: "label",
				text: entry.label ?? "",
				bookkeeping: true,
				toolCallsOnly: false,
				errorOrAborted: false,
			};
	}
}

/**
 * The full-entry tree projection: one node per entry, the current-path set
 * walked from the session manager's authoritative leaf, the resolved label
 * map, and the assistant tool-call index toolResult summaries read from.
 */
export function projectHistoryTree(
	entries: readonly SessionEntry[],
	labels: ReadonlyMap<string, string>,
	leafId: string | null,
): WebHistoryNode[] {
	const pathIds = new Set<string>();
	const byId = new Map(entries.map(entry => [entry.id, entry] as const));
	let cursor: string | undefined = leafId ?? undefined;
	while (cursor !== undefined) {
		pathIds.add(cursor);
		const entry = byId.get(cursor) as { parentId: string | null } | undefined;
		cursor = entry?.parentId ?? undefined;
	}
	const toolCalls = new Map<string, { name: string; arguments: Record<string, unknown> }>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const content = (entry.message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall") {
				const call = block as { id: string; name: string; arguments: Record<string, unknown> };
				toolCalls.set(call.id, { name: call.name, arguments: call.arguments });
			}
		}
	}
	return entries.map(entry => {
		const node = describeHistoryEntry(entry, toolCalls);
		const label = labels.get(entry.id);
		return {
			...node,
			...(label !== undefined ? { label } : {}),
			timestamp: Date.parse(entry.timestamp),
			onCurrentPath: pathIds.has(entry.id),
			currentLeaf: entry.id === leafId,
		};
	});
}
