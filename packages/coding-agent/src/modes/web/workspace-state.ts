/**
 * Web-workspace display overrides.
 *
 * The dsh sidebar vocabulary (archived sessions, renamed workspaces,
 * drag-ordered workspaces/sessions, pre-created empty workspaces) has no
 * seat in OMP session storage, so the web host keeps one JSON document at
 * `~/.omp/web-workspaces.json`. Storage-bucket data (the workspace set,
 * session membership, mtimes) still derives from `FileSessionStorage`; this
 * file only carries the deltas the user applied through the GUI.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** One persisted overrides document (schema versioned for forward edits). */
interface WorkspaceOverridesDoc {
	version: 1;
	/** Sessions hidden from the sidebar without deleting their logs. */
	archivedSessionIds: string[];
	/** workspaceId → display title override. */
	workspaceTitles: Record<string, string>;
	/** Display order of known workspaceIds; unknown buckets append by recency. */
	workspaceOrder: string[];
	/** workspaceId → display order of its sessionIds; unknown sessions append by recency. */
	sessionOrders: Record<string, string[]>;
	/** Pre-created (possibly empty) workspace paths the user adopted. */
	plannedPaths: string[];
}

/** In-memory view over the overrides document. */
export class WorkspaceOverrides {
	readonly #file: string;
	#doc: WorkspaceOverridesDoc;

	constructor(file: string) {
		this.#file = file;
		this.#doc = WorkspaceOverrides.#load(file);
	}

	/** Archived (sidebar-hidden) session ids. */
	archivedSessionIds(): string[] {
		return [...this.#doc.archivedSessionIds];
	}

	/** Mark one session archived. */
	archiveSession(sessionId: string): string[] {
		if (!this.#doc.archivedSessionIds.includes(sessionId)) {
			this.#doc.archivedSessionIds.push(sessionId);
			this.#save();
		}
		return this.archivedSessionIds();
	}

	/** Title override for one workspace, when set. */
	workspaceTitle(workspaceId: string): string | undefined {
		return this.#doc.workspaceTitles[workspaceId];
	}

	/** Persist a workspace title override. */
	renameWorkspace(workspaceId: string, title: string): void {
		this.#doc.workspaceTitles[workspaceId] = title;
		this.#save();
	}

	/** Record one planned (possibly empty) workspace path. */
	planWorkspace(workspaceId: string): void {
		if (!this.#doc.plannedPaths.includes(workspaceId)) {
			this.#doc.plannedPaths.push(workspaceId);
			this.#save();
		}
	}

	/** Planned workspace paths. */
	plannedWorkspaces(): string[] {
		return [...this.#doc.plannedPaths];
	}

	/** Drop every override tied to one workspace (after deletion). */
	forgetWorkspace(workspaceId: string): void {
		delete this.#doc.workspaceTitles[workspaceId];
		delete this.#doc.sessionOrders[workspaceId];
		this.#doc.workspaceOrder = this.#doc.workspaceOrder.filter(id => id !== workspaceId);
		this.#doc.plannedPaths = this.#doc.plannedPaths.filter(id => id !== workspaceId);
		this.#save();
	}

	/**
	 * Move one workspace before another (anchor omitted = append); returns the
	 * full resulting order including workspaces with no override record.
	 */
	insertWorkspaceBefore(workspaceId: string, beforeWorkspaceId: string | undefined, known: string[]): string[] {
		const order = this.#orderedIds(known, this.#doc.workspaceOrder).filter(id => id !== workspaceId);
		const anchor = beforeWorkspaceId === undefined ? order.length : order.indexOf(beforeWorkspaceId);
		order.splice(anchor === -1 ? order.length : anchor, 0, workspaceId);
		this.#doc.workspaceOrder = order;
		this.#save();
		return order;
	}

	/** Move one session inside its workspace (anchor omitted = append); returns the new order. */
	insertSessionBefore(
		workspaceId: string,
		sessionId: string,
		beforeSessionId: string | undefined,
		known: string[],
	): string[] {
		const current = this.#orderedIds(known, this.#doc.sessionOrders[workspaceId] ?? []).filter(
			id => id !== sessionId,
		);
		const anchor = beforeSessionId === undefined ? current.length : current.indexOf(beforeSessionId);
		current.splice(anchor === -1 ? current.length : anchor, 0, sessionId);
		this.#doc.sessionOrders[workspaceId] = current;
		this.#save();
		return current;
	}

	/** Apply the persisted workspace ordering onto a recency-sorted id list. */
	applyWorkspaceOrder(known: string[]): string[] {
		return this.#orderedIds(known, this.#doc.workspaceOrder);
	}

	/** Apply the persisted session ordering onto one workspace's recency-sorted ids. */
	applySessionOrder(workspaceId: string, known: string[]): string[] {
		return this.#orderedIds(known, this.#doc.sessionOrders[workspaceId] ?? []);
	}

	/** Merge the persisted order into the known set (unknown ids append in place). */
	#orderedIds(known: string[], order: string[]): string[] {
		const knownSet = new Set(known);
		const result: string[] = [];
		for (const id of order) {
			if (knownSet.has(id) && !result.includes(id)) result.push(id);
		}
		for (const id of known) {
			if (!result.includes(id)) result.push(id);
		}
		return result;
	}

	#save(): void {
		mkdirSync(path.dirname(this.#file), { recursive: true });
		writeFileSync(this.#file, `${JSON.stringify(this.#doc, null, 2)}\n`, "utf-8");
	}

	static #load(file: string): WorkspaceOverridesDoc {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<WorkspaceOverridesDoc>;
			return {
				version: 1,
				archivedSessionIds: Array.isArray(parsed.archivedSessionIds)
					? parsed.archivedSessionIds.filter((id): id is string => typeof id === "string")
					: [],
				workspaceTitles:
					typeof parsed.workspaceTitles === "object" && parsed.workspaceTitles !== null
						? parsed.workspaceTitles
						: {},
				workspaceOrder: Array.isArray(parsed.workspaceOrder)
					? parsed.workspaceOrder.filter((id): id is string => typeof id === "string")
					: [],
				sessionOrders:
					typeof parsed.sessionOrders === "object" && parsed.sessionOrders !== null ? parsed.sessionOrders : {},
				plannedPaths: Array.isArray(parsed.plannedPaths)
					? parsed.plannedPaths.filter((id): id is string => typeof id === "string")
					: [],
			};
		} catch {
			return {
				version: 1,
				archivedSessionIds: [],
				workspaceTitles: {},
				workspaceOrder: [],
				sessionOrders: {},
				plannedPaths: [],
			};
		}
	}
}
