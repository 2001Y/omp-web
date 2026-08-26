/**
 * Web-mode command lifecycle bridge and history paging contracts.
 *
 * Covers the M3 additions to `SessionEventTranslator` (synthetic
 * command/run + command/done events, persisted command records folding back
 * at their original positions) and the `pageHistory` message-boundary window.
 */
import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { WebSessionEvent } from "@oh-my-pi/web";
import { pageHistory } from "../../src/modes/web/driver";
import {
	COMMAND_ENTRY_TYPE,
	commandRecordOf,
	type HistoryItem,
	SessionEventTranslator,
} from "../../src/modes/web/translate";
import type { FileEntry } from "../../src/session/session-entries";

/** Test message with the entry id the folding relies on. */
interface FixtureMessage {
	id: string;
	message: AgentMessage;
}

function userMessage(text: string, timestamp: number): FixtureMessage {
	const id = crypto.randomUUID();
	return { id, message: { id, role: "user", content: text, timestamp } as AgentMessage };
}

function assistantMessage(text: string, timestamp: number): FixtureMessage {
	const id = crypto.randomUUID();
	return {
		id,
		message: {
			id,
			role: "assistant",
			content: [{ type: "text", text }],
			timestamp,
			provider: "test",
			model: "test-model",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		} as unknown as AgentMessage,
	};
}

function commandEntry(data: Record<string, unknown>, timestamp = "2026-08-24T10:00:00.000Z"): FileEntry {
	return {
		type: "custom",
		id: crypto.randomUUID(),
		parentId: null,
		timestamp,
		customType: COMMAND_ENTRY_TYPE,
		data,
	} as FileEntry;
}

function messageEntry(fixture: FixtureMessage): FileEntry {
	return { type: "message", id: fixture.id, parentId: null, timestamp: "", message: fixture.message } as FileEntry;
}

test("appendCommandRun/Done mint paired events in the canonical log", () => {
	const translator = new SessionEventTranslator();
	const run = translator.appendCommandRun("cmd-1", "usage", " extra");
	const done = translator.appendCommandDone("cmd-1", "success", "quota fine");
	expect(run).toMatchObject({ type: "command/run", data: { commandId: "cmd-1", name: "usage", args: " extra" } });
	expect(done).toMatchObject({
		type: "command/done",
		data: { commandId: "cmd-1", kind: "success", text: "quota fine" },
	});
	expect(translator.log.map(event => event.type)).toEqual(["command/run", "command/done"]);
	// Empty args and empty text stay absent (the dsh descriptor contract).
	const bare = new SessionEventTranslator();
	expect(bare.appendCommandRun("cmd-2", "stats", "")).not.toHaveProperty("data.args");
	expect(bare.appendCommandDone("cmd-2", "success", undefined)).not.toHaveProperty("data.text");
});

test("adoptEntries interleaves persisted command records with message history", () => {
	const translator = new SessionEventTranslator();
	const items: HistoryItem[] = [
		{ kind: "message", message: userMessage("hello", 1).message },
		{
			kind: "command",
			record: { phase: "run", commandId: "c1", name: "usage", args: "" },
			time: 2,
		},
		{ kind: "command", record: { phase: "done", commandId: "c1", kind: "success", text: "ok" }, time: 3 },
		{ kind: "message", message: assistantMessage("hi", 4).message },
	];
	const events = translator.translateItems(items);
	const types = events.map(event => event.type);
	// The command pair lands between the user turn and the assistant step,
	// at its original position in the interleaved stream.
	expect(types.indexOf("command/run")).toBeGreaterThan(types.indexOf("user/message"));
	expect(types.indexOf("command/run")).toBeLessThan(types.indexOf("step/start"));
	expect(types).toEqual([
		"turn/start",
		"user/message",
		"command/run",
		"command/done",
		"step/start",
		"assistant/message",
		"step/end",
		"turn/end",
	]);
	// A follow-up live translate continues the same seq space.
	const next = translator.translate({ type: "turn_start" } as never);
	expect(next[0]?.seq).toBe(events.at(-1)!.seq + 1);
});

test("commandRecordOf narrows only omp-web command customs", () => {
	expect(commandRecordOf({ type: "custom", customType: "other", data: { phase: "run" } })).toBeUndefined();
	expect(
		commandRecordOf({ type: "custom", customType: COMMAND_ENTRY_TYPE, data: { phase: "nope", commandId: "x" } }),
	).toBeUndefined();
	const record = commandRecordOf(commandEntry({ phase: "done", commandId: "c9", kind: "error", text: "bad" }));
	expect(record).toEqual({ phase: "done", commandId: "c9", kind: "error", text: "bad" });
});

test("adoptEntries reconstructs the identical shape from raw file entries", () => {
	const translator = new SessionEventTranslator();
	translator.adoptEntries([
		messageEntry(userMessage("one", 1)),
		commandEntry({ phase: "run", commandId: "c1", name: "usage", args: "" }),
		commandEntry({ phase: "done", commandId: "c1", kind: "success", text: "out" }),
		messageEntry(assistantMessage("two", 5)),
	]);
	const types = translator.log.map(event => event.type);
	expect(types).toContain("command/run");
	expect(types).toContain("command/done");
	const done = translator.log.find(event => event.type === "command/done") as Extract<
		WebSessionEvent,
		{ type: "command/done" }
	>;
	expect(done.data.text).toBe("out");
});

test("pageHistory cuts at turn boundaries and reports more", () => {
	const translator = new SessionEventTranslator();
	for (let i = 0; i < 6; i++) {
		translator.translateItems([
			{ kind: "message", message: userMessage(`u${i}`, i).message },
			{ kind: "message", message: assistantMessage(`a${i}`, i + 0.5).message },
		]);
	}
	const all = [...translator.log];
	// Budget 4 messages: the window must open on a turn/start and leave more.
	const first = pageHistory(all, { maxMessages: 4 });
	expect(first.events[0]?.type).toBe("turn/start");
	expect(first.hasMore).toBe(true);
	const messageCount = first.events.filter(
		event => event.type === "user/message" || event.type === "assistant/message",
	).length;
	expect(messageCount).toBeLessThanOrEqual(4);
	// The next page anchors below the window's first seq and reaches the head.
	const second = pageHistory(all, { beforeSeq: first.events[0]!.seq, maxMessages: 4 });
	expect(second.events.every(event => event.seq < first.events[0]!.seq)).toBe(true);
	expect(second.events[0]?.type).toBe("turn/start");
	// A whole-log budget returns everything with no more pages.
	const full = pageHistory(all, { maxMessages: 50 });
	expect(full.hasMore).toBe(false);
	expect(full.events.length).toBe(all.length);
});

test("pageHistory never serves an empty page for an over-budget turn", () => {
	// One small turn, then a single giant turn exceeding the message budget:
	// the budget cut lands mid-turn with no later boundary, and the window
	// must extend back to that turn's start rather than soft-lock load-older
	// on an empty page.
	const translator = new SessionEventTranslator();
	translator.translateItems([
		{ kind: "message", message: userMessage("small", 0).message },
		{ kind: "message", message: assistantMessage("small-a", 0.5).message },
	]);
	// A genuine single giant turn: one user message plus many assistant steps
	// (the history fold keeps consecutive assistant messages in one turn).
	const giant: HistoryItem[] = [{ kind: "message", message: userMessage("giant", 1).message }];
	for (let i = 0; i < 40; i++) {
		giant.push({ kind: "message", message: assistantMessage(`g${i}`, i + 1.5).message });
	}
	translator.translateItems(giant);
	const all = [...translator.log];
	const page = pageHistory(all, { maxMessages: 10 });
	expect(page.events.length).toBeGreaterThan(0);
	expect(page.events[0]?.type).toBe("turn/start");
	expect(page.hasMore).toBe(true);
	// The extended window opens exactly on the giant turn's start: the small
	// turn stays on the older page.
	expect(page.events.some(event => event.type === "user/message")).toBe(true);
	const older = pageHistory(all, { beforeSeq: page.events[0]!.seq, maxMessages: 10 });
	expect(older.events.length).toBeGreaterThan(0);
	expect(older.hasMore).toBe(false);
	// A giant LATEST turn with no prior history: the initial page is the whole
	// turn (empty + hasMore would blank a fresh load and wedge the pager).
	const solo = new SessionEventTranslator();
	solo.translateItems(giant);
	const initial = pageHistory([...solo.log], { maxMessages: 10 });
	expect(initial.events.length).toBe(solo.log.length);
	expect(initial.hasMore).toBe(false);
});

test("steering user messages fold into the transcript as ordinary user turns", () => {
	const steering = userMessage("also check the logs", 1);
	(steering.message as unknown as { steering: boolean }).steering = true;
	const translator = new SessionEventTranslator();
	const historyEvents = translator.translateItems([{ kind: "message", message: steering.message }]);
	expect(historyEvents.map(event => event.type)).toEqual(["turn/start", "user/message", "turn/end"]);
	// The live path folds it identically; mid-turn it opens no new turn.
	const live = new SessionEventTranslator();
	live.translate({ type: "turn_start" } as never);
	const liveEvents = live.translate({ type: "message_start", message: steering.message } as never);
	expect(liveEvents.map(event => event.type)).toEqual(["user/message"]);
});

test("redactedThinking blocks drop instead of rendering the opaque blob", () => {
	const message = assistantMessage("visible", 1);
	(message.message as unknown as { content: unknown[] }).content = [
		{ type: "redactedThinking", data: "encrypted-opaque-blob" },
		{ type: "text", text: "visible" },
	];
	const translator = new SessionEventTranslator();
	const events = translator.translateItems([{ kind: "message", message: message.message }]);
	const assistant = events.find(event => event.type === "assistant/message");
	expect(assistant).toBeDefined();
	const content = (assistant as Extract<WebSessionEvent, { type: "assistant/message" }>).data.message.content;
	expect(content).toEqual([{ type: "text", text: "visible" }]);
});
