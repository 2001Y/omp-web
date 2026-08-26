/**
 * Durable image attachments for the web host.
 *
 * Attachment identity is content-derived: `att_<sha256(mediaType + "\0" +
 * bytes).slice(0,24)>` recomputed identically by the translator (history
 * emission) and the `session.attachment` endpoint (fetch), so no separate
 * store exists and the session log itself is the authorization boundary —
 * an attachment is resolvable exactly while the session's own entries
 * reference it.
 */

import { createHash } from "node:crypto";
import { getImageDimensions } from "@oh-my-pi/pi-tui/terminal-capabilities";
import type { WebImageMediaType } from "@oh-my-pi/web";
import type { FileEntry } from "../../session/session-entries";

/** The resolved durable reference plus its base64 payload. */
export interface AttachmentPayload {
	attachmentId: string;
	mediaType: WebImageMediaType;
	bytes: number;
	width: number;
	height: number;
	name?: string;
	data: string;
}

/** Compute the durable attachment id for one image payload. */
export function attachmentIdOf(mediaType: string, base64Data: string): string {
	const bytes = Buffer.from(base64Data, "base64");
	const digest = createHash("sha256").update(mediaType).update("\0").update(bytes).digest("hex");
	return `att_${digest.slice(0, 24)}`;
}

/** Build the wire reference for one image payload; undefined when undecodable. */
export function attachmentRefOf(
	mediaType: string,
	base64Data: string,
	name?: string,
): Omit<AttachmentPayload, "data"> | undefined {
	const bytes = Buffer.from(base64Data, "base64");
	if (bytes.byteLength === 0) return undefined;
	// getImageDimensions supports exactly the four wire media types; a null
	// probe therefore also rejects out-of-vocabulary types.
	const dimensions = getImageDimensions(base64Data, mediaType);
	if (dimensions === null) return undefined;
	return {
		attachmentId: attachmentIdOf(mediaType, base64Data),
		mediaType: mediaType as WebImageMediaType,
		bytes: bytes.byteLength,
		width: dimensions.widthPx,
		height: dimensions.heightPx,
		...(name !== undefined && name !== "" ? { name } : {}),
	};
}

/**
 * Scan one session's entries for every referenced image payload. The result
 * is keyed by attachmentId; `session.attachment` resolves against it, so the
 * session log itself authorizes the fetch.
 */
export function collectSessionAttachments(entries: ReadonlyArray<FileEntry>): Map<string, AttachmentPayload> {
	const out = new Map<string, AttachmentPayload>();
	const consider = (mimeType: string, data: string): void => {
		const ref = attachmentRefOf(mimeType, data);
		if (ref === undefined) return;
		if (!out.has(ref.attachmentId)) out.set(ref.attachmentId, { ...ref, data });
	};
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user" && Array.isArray(message.content)) {
			for (const block of message.content) {
				if (block.type === "image") consider(block.mimeType, block.data);
			}
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "image") consider(block.mimeType, block.data);
			}
		} else if (message.role === "toolResult") {
			for (const block of message.content) {
				if (block.type === "image") consider(block.mimeType, block.data);
			}
		}
	}
	return out;
}
