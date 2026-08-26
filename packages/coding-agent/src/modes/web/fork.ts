/**
 * File-level session fork (the `session.fork` RPC and the History view's
 * fork-here): cut the source log at the anchor and materialize the child
 * through OMP's own `SessionManager.forkFrom` — the one native writer — so
 * the child file (title slot, header normalization, blob refs, artifacts) is
 * exactly what interactive `/fork` produces. The truncated source is staged
 * as a raw line-prefix of the original file in the OS temp dir and deleted
 * afterwards; no hand-written session serialization exists anywhere.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSessionFile } from "../../session/session-loader";
import { copySessionArtifacts, SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { historyItemsOf } from "./driver";
import { SessionEventTranslator } from "./translate";

/** The physical-line fields the cut needs (kept minimal on purpose). */
interface LineFacts {
	type: string | undefined;
	timestamp: string | undefined;
}

function lineFacts(raw: string): LineFacts {
	try {
		const parsed = JSON.parse(raw) as { type?: unknown; timestamp?: unknown };
		return {
			type: typeof parsed.type === "string" ? parsed.type : undefined,
			timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : undefined,
		};
	} catch {
		return { type: undefined, timestamp: undefined };
	}
}

/**
 * Fork one persisted session at an anchor, natively.
 * @param sourcePath - absolute JSONL path of the source session.
 * @param anchor - `entryId` cuts right after that entry (its timestamp is the
 * boundary — the fork includes it); `atSeq` cuts at the first `turn/end` at
 * or after it (the forking message's seq, so its whole turn is included);
 * omitted cuts at the last completed turn.
 * @returns the child session's id (the file lands in the source's bucket).
 */
export async function forkSessionFile(
	sourcePath: string,
	anchor?: { atSeq?: number; entryId?: string },
): Promise<{ sessionId: string }> {
	const storage = new FileSessionStorage();
	const entries = (await loadSessionFile(sourcePath, storage)).entries;
	if (entries.length === 0) throw new Error("omp-web: cannot fork an empty session");
	const header = entries[0] as unknown as { type: string; cwd: string };
	if (header.type !== "session") throw new Error("omp-web: session file lacks a header entry");

	// Resolve the cut to a timestamp over the loaded entries.
	let cutoff: number;
	if (anchor?.entryId !== undefined) {
		const anchorEntry = entries.find(entry => entry.id === anchor.entryId);
		if (anchorEntry === undefined) throw new Error(`omp-web: fork anchor entry ${anchor.entryId} not found`);
		cutoff = Date.parse((anchorEntry as { timestamp: string }).timestamp);
	} else {
		// Fold the source to translated events to locate the turn boundary; the
		// boundary's event time (a persisted message timestamp) cuts the file.
		const events = new SessionEventTranslator().translateItems(historyItemsOf(entries));
		const turnEnds = events.filter(event => event.type === "turn/end");
		const anchorSeq = anchor?.atSeq;
		const boundary =
			(anchorSeq === undefined ? turnEnds.at(-1) : turnEnds.find(event => event.seq >= anchorSeq)) ?? undefined;
		cutoff = boundary !== undefined ? boundary.time : Number.MAX_SAFE_INTEGER;
	}

	// Stage the truncated source as a byte-exact prefix of the physical file
	// (title slot + header + entries up to the cut) under the OS temp dir, so
	// the bucket never sees an intermediate file.
	const raw = await fs.readFile(sourcePath, "utf8");
	const staged: string[] = [];
	for (const line of raw.split("\n")) {
		if (line === "") continue;
		const facts = lineFacts(line);
		if (facts.type === "title" || facts.type === "session") {
			staged.push(line);
			continue;
		}
		const time = Date.parse(facts.timestamp ?? "");
		if (Number.isNaN(time) || time <= cutoff) staged.push(line);
	}
	const stagePath = path.join(os.tmpdir(), `omp-web-fork-${crypto.randomUUID()}.jsonl`);
	await fs.writeFile(stagePath, `${staged.join("\n")}\n`);
	try {
		const child = await SessionManager.forkFrom(stagePath, header.cwd, undefined, storage, {
			copyArtifacts: false,
		});
		const childFile = child.getSessionFile();
		const sessionId = child.getSessionId();
		await child.close();
		// Artifacts belong to the real source, not the temp stage.
		if (childFile !== undefined) await copySessionArtifacts(sourcePath, childFile);
		return { sessionId };
	} finally {
		await fs.rm(stagePath, { force: true });
	}
}
