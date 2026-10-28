/**
 * Composition of the browser boot graph (`window.__DSH_BOOT__`) for the
 * vendored dsh-web client stack.
 *
 * The dsh host derives this graph from its Cordis Loader entries
 * (`@deepseek-ai/dsh-client-modules` node half); the omp web host has no
 * Cordis loader, so the graph is composed statically from the same plugin
 * roster the `dsh web` profile activates (web-app bundle patch browser rows
 * plus the dual-face base rows) resolved against the vendored package tree.
 * Pure data adaptation: no browser code and no host runtime are involved.
 */

import { createHash } from "node:crypto";
import * as path from "node:path";
import { deriveBootRoster } from "./roster";

/**
 * Fallback browser roster for trees without bundle patches (legacy or
 * fixture trees). Live trees derive their roster from their own
 * `cordis.patch.yml` layers via {@link deriveBootRoster}; this list is
 * the last 0.1.x-era hand roster, kept only so old trees still boot.
 */
export const BOOT_ROSTER: readonly string[] = [
	// web-app bundle patch browser roster
	"@deepseek-ai/dsh-client-modules",
	"@deepseek-ai/dsh-client-connection",
	"@deepseek-ai/dsh-api-remotes",
	"@deepseek-ai/dsh-client-runtime",
	"@deepseek-ai/dsh-cordis-client-runner",
	"@deepseek-ai/dsh-client-ui-theme",
	"@deepseek-ai/dsh-client-locale",
	"@deepseek-ai/dsh-client-ui-layout",
	"@deepseek-ai/dsh-client-ui-renderer",
	"@deepseek-ai/dsh-client-ui-sidebar",
	"@deepseek-ai/dsh-client-ui-settings",
	"@deepseek-ai/dsh-client-ui-settings-general",
	// dsh-native settings sections with no omp counterpart are left out of the
	// roster (models/plugins/inventory/presets/permission ride dsh-host services
	// the omp backend never provides).
	"@deepseek-ai/dsh-client-ui-conversation",
	"@deepseek-ai/dsh-client-ui-brand-official",
	"@deepseek-ai/dsh-client-ui-attachment",
	"@deepseek-ai/dsh-client-ui-tool",
	"@deepseek-ai/dsh-client-ui-cordis",
	"@deepseek-ai/dsh-client-ui-workflow-run",
	"@deepseek-ai/dsh-client-ui-deliverables",
	"@deepseek-ai/dsh-client-ui-workspace",
	// The browse picker fills the directory-flow holes over host.listDirectory/
	// host.createDirectory + workspace.create, all of which this host serves;
	// the NATIVE picker stays out (it drives a desktop dialog this web host
	// cannot open).
	"@deepseek-ai/dsh-client-ui-directory-picker-browse",
	"@deepseek-ai/dsh-client-ui-input-trigger",
	"@deepseek-ai/dsh-client-ui-commands",
	"@deepseek-ai/dsh-client-ui-skill",
	"@deepseek-ai/dsh-client-ui-subagent",
	"@deepseek-ai/dsh-client-ui-reference",
	"@deepseek-ai/dsh-client-ui-jobs",
	"@deepseek-ai/dsh-client-ui-goal",
	// ui-message-feedback is deliberately absent: its thumbs affordance writes
	// through messageFeedback/* endpoints the omp host does not serve (no
	// feedback telemetry exists in OMP), so rostering it would mount a dead
	// control on every assistant message (audit M19 decision).
	"@deepseek-ai/dsh-client-ui-model-selection",
	"@deepseek-ai/dsh-client-ui-plan",
	"@deepseek-ai/dsh-client-ui-user-questions",
	"@deepseek-ai/dsh-client-ui-trajectory",
	// web-app patch layer-2 rows with browser halves
	// (client-hmr is deliberately absent: it is a dev-only hot-reload plugin
	// whose /plugins/events EventSource this host does not serve).
	"@deepseek-ai/dsh-session-log-export",
	// dual-face base rows active in every profile
	"@deepseek-ai/dsh-typert-registry",
	"@deepseek-ai/dsh-api-gateway",
	// the omp fork's own sections (settings tabs over the ompSettings RPCs)
	"@omp/client-settings",
];

/** The bootstrap package: its bundle supplies the module-system implementation. */
export const BOOTSTRAP_PACKAGE_ID = "@deepseek-ai/dsh-client-modules";

/** Byte cap on one combo (concatenated bundle) URL, per the dsh client-modules node half. */
export const COMBO_URL_BYTE_LIMIT = 3072;

/** One composed browser entry pushed to the boot graph (wire shape). */
export interface WebBootEntry {
	/** Entry name == package name. */
	id: string;
	/** Combo reference to this entry's bundle, `plugins/??<id>/client.js&rev=<rev>` (document-relative). */
	url: string;
	/** Bundle content hash (cache-busting consistency anchor). */
	rev: string;
	/** Package-name dependency edges, informational. */
	inject?: string[];
	/** Stage-one prefetch mark. */
	immediately?: boolean;
	/** Non-baseline module specifiers this row requests; omitted when none. */
	external?: string[];
}

/** One initial-load batch of the boot graph (wire shape, dsh 0.2.x). */
export interface WebBootBatch {
	/** Load phase: the bootstrap batch runs parser-blocking; application batches are preloaded. */
	phase: "bootstrap" | "application";
	/** Combo reference covering every entry in `entries`, in order. */
	url: string;
	/** Consistency anchor over the member bundles' revs. */
	rev: string;
	/** Member entry ids, in load order. Every graph entry belongs to exactly one batch. */
	entries: string[];
}

/** The composed entry graph injected as `window.__DSH_BOOT__`. */
export interface WebBootGraph {
	/** Consistency anchor over the whole graph. */
	rev: string;
	/** Release identity of the vendored dsh tree, when known. */
	release?: { version: string; commit?: string };
	/** Entries in module-graph order. */
	entries: WebBootEntry[];
	/** Initial-load batches covering every entry exactly once (required since dsh 0.2.x). */
	batches: WebBootBatch[];
}

/** Document-relative combo reference for a set of bundles, in load order. */
export function comboUrl(ids: readonly string[], rev: string): string {
	return `plugins/??${ids.map(id => `${id}/client.js`).join(",")}&rev=${rev}`;
}

const utf8 = new TextEncoder();

/**
 * Group ordered entries into initial-load batches: the bootstrap package
 * alone forms the bootstrap batch; the remaining entries are packed in
 * graph order into application batches whose combo URL stays within
 * {@link COMBO_URL_BYTE_LIMIT}.
 */
export function composeBatches(entries: readonly WebBootEntry[]): WebBootBatch[] {
	const batches: WebBootBatch[] = [];
	const batchOf = (phase: WebBootBatch["phase"], members: readonly WebBootEntry[]): WebBootBatch => {
		const ids = members.map(entry => entry.id);
		const rev = shortHash(members.map(entry => entry.rev).join(","));
		return { phase, url: comboUrl(ids, rev), rev, entries: ids };
	};
	const bootstrap = entries.filter(entry => entry.id === BOOTSTRAP_PACKAGE_ID);
	if (bootstrap.length > 0) batches.push(batchOf("bootstrap", bootstrap));
	let current: WebBootEntry[] = [];
	for (const entry of entries) {
		if (entry.id === BOOTSTRAP_PACKAGE_ID) continue;
		const trial = [...current, entry];
		const trialUrl = comboUrl(
			trial.map(row => row.id),
			"0".repeat(12),
		);
		if (current.length > 0 && utf8.encode(trialUrl).length > COMBO_URL_BYTE_LIMIT) {
			batches.push(batchOf("application", current));
			current = [];
		}
		current.push(entry);
	}
	if (current.length > 0) batches.push(batchOf("application", current));
	return batches;
}

/** One roster package resolved for serving: wire entry plus bundle location. */
export interface BootPluginRecord {
	entry: WebBootEntry;
	/** Absolute path of the built `client.js` browser bundle. */
	clientPath: string;
}

/** The full composition result the web server serves from. */
export interface ComposedBoot {
	graph: WebBootGraph;
	/** Roster id → resolved record; the `/plugins/` route's source of truth. */
	table: Map<string, BootPluginRecord>;
}

/** package.json `dsh.client` declaration fields, validated one by one. */
interface DshClientDeclaration {
	inject?: string[];
	platform: string;
	immediately?: boolean;
	external?: string[];
}

/** sha1 content hash shortened to 12 hex chars (bundle rev / graph rev). */
function shortHash(input: string | Uint8Array): string {
	return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

/**
 * Normalize a module specifier onto the graph row that owns it: a plugin
 * bundle IS its package's client half, so `<id>/client` and the bare package
 * name resolve to the same exports.
 */
export function stripClientSuffix(spec: string): string {
	return spec.endsWith("/client") ? spec.slice(0, -"/client".length) : spec;
}

/**
 * Order composed rows so every requested dynamic package precedes its
 * consumers. An `external` specifier is either the package row it names
 * (`<pkg>/client` aliases the bare package) or a static-table name that adds
 * no graph edge.
 * @param entries - composed rows in scan order.
 * @returns the same rows reordered; scan order breaks every tie.
 * @throws {Error} when a row requests itself or the module graph has a cycle.
 */
export function orderByModuleGraph(entries: readonly WebBootEntry[]): WebBootEntry[] {
	const rowsById = new Map<string, WebBootEntry>();
	for (const entry of entries) rowsById.set(entry.id, entry);
	const ordered: WebBootEntry[] = [];
	const placed = new Set<string>();
	const open: string[] = [];
	const visit = (entry: WebBootEntry): void => {
		if (placed.has(entry.id)) return;
		const cycleStart = open.indexOf(entry.id);
		if (cycleStart !== -1) {
			throw new Error(
				`web boot: module graph cycle ${[...open.slice(cycleStart), entry.id].join(" -> ")} — a requested package row must precede its consumers`,
			);
		}
		open.push(entry.id);
		for (const name of entry.external ?? []) {
			const dependency = rowsById.get(name) ?? rowsById.get(stripClientSuffix(name));
			if (dependency === entry) {
				throw new Error(
					`web boot: "${entry.id}" requests module "${name}" that it answers itself — a row must not declare its own package in dsh.client.external`,
				);
			}
			if (dependency !== undefined) visit(dependency);
		}
		open.pop();
		placed.add(entry.id);
		ordered.push(entry);
	};
	for (const entry of entries) visit(entry);
	return ordered;
}

/** Narrow an unknown parsed JSON value to the `dsh.client` declaration. */
function parseDshClient(pkgName: string, value: unknown): DshClientDeclaration | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "object" || value === null) {
		throw new Error(`web boot: ${pkgName} has a non-object dsh.client declaration`);
	}
	const decl = value as Record<string, unknown>;
	if (typeof decl.platform !== "string") {
		throw new Error(`web boot: ${pkgName} dsh.client.platform must be a string`);
	}
	const optionalStringArray = (field: string): string[] | undefined => {
		const raw = decl[field];
		if (raw === undefined) return undefined;
		if (!Array.isArray(raw) || raw.some(item => typeof item !== "string")) {
			throw new Error(`web boot: ${pkgName} dsh.client.${field} must be a string array`);
		}
		return raw;
	};
	const inject = optionalStringArray("inject");
	const external = optionalStringArray("external");
	if (decl.immediately !== undefined && typeof decl.immediately !== "boolean") {
		throw new Error(`web boot: ${pkgName} dsh.client.immediately must be a boolean`);
	}
	return {
		platform: decl.platform,
		...(inject !== undefined ? { inject } : {}),
		...(external !== undefined ? { external } : {}),
		...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
	};
}

/**
 * Resolve `exports["./client"]` to a relative path, accepting the string and
 * one-level conditional forms.
 */
function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
	if (typeof exportsField !== "object" || exportsField === null) return undefined;
	const client = (exportsField as Record<string, unknown>)["./client"];
	if (client === undefined) return undefined;
	if (typeof client === "string") return client;
	if (typeof client === "object" && client !== null) {
		const fallback = (client as Record<string, unknown>).default;
		if (typeof fallback === "string") return fallback;
	}
	throw new Error(`web boot: ${pkgName} exports["./client"] must be a string or an object with a string default`);
}

/** Graph row for one bundle rev (url is the single-bundle combo reference). */
function graphRow(id: string, rev: string, decl: DshClientDeclaration): WebBootEntry {
	return {
		id,
		url: comboUrl([id], rev),
		rev,
		...(decl.inject !== undefined ? { inject: decl.inject } : {}),
		...(decl.immediately === true ? { immediately: true } : {}),
		...(decl.external !== undefined && decl.external.length > 0 ? { external: decl.external } : {}),
	};
}

/**
 * Index every workspace package of the vendored tree by package name.
 * @param dshRoot - absolute path of the vendored dsh-web checkout.
 * @returns package name → package directory.
 */
async function indexPackages(dshRoot: string): Promise<Map<string, string>> {
	const index = new Map<string, string>();
	const glob = new Bun.Glob("packages/*/*/package.json");
	for await (const rel of glob.scan({ cwd: dshRoot })) {
		const manifest = (await Bun.file(path.join(dshRoot, rel)).json()) as { name?: unknown };
		if (typeof manifest.name !== "string") continue;
		index.set(manifest.name, path.join(dshRoot, path.dirname(rel)));
	}
	return index;
}

/**
 * Compose the boot graph for the vendored dsh-web tree.
 * @param dshRoot - absolute path of the vendored dsh-web checkout.
 * @param roster - browser roster by package name; defaults to {@link BOOT_ROSTER}.
 * @returns the graph plus the serving table for the `/plugins/` route.
 * @throws {Error} when a roster package is missing from the tree, lacks a web
 * `dsh.client` declaration or a `./client` export, or its built bundle is
 * absent (run the dsh-web build first).
 */
export async function composeBootGraph(
	dshRoot: string,
	roster?: readonly string[],
	release?: { version: string; commit?: string },
): Promise<ComposedBoot> {
	roster ??= (await deriveBootRoster(dshRoot)) ?? BOOT_ROSTER;
	const packages = await indexPackages(dshRoot);
	const table = new Map<string, BootPluginRecord>();
	for (const id of roster) {
		const pkgDir = packages.get(id);
		if (pkgDir === undefined) {
			throw new Error(`web boot: roster package ${id} not found under ${dshRoot}/packages`);
		}
		const manifest = (await Bun.file(path.join(pkgDir, "package.json")).json()) as {
			dsh?: { client?: unknown };
			exports?: unknown;
		};
		const decl = parseDshClient(id, manifest.dsh?.client);
		if (decl === undefined || decl.platform !== "web") {
			throw new Error(`web boot: roster package ${id} declares no web dsh.client half`);
		}
		const clientRel = clientExportOf(id, manifest.exports);
		if (clientRel === undefined) {
			throw new Error(`web boot: roster package ${id} declares dsh.client but exports no "./client" bundle`);
		}
		const clientPath = path.join(pkgDir, clientRel);
		const bundle = Bun.file(clientPath);
		if (!(await bundle.exists())) {
			throw new Error(`web boot: client bundle not found for ${id}: ${clientPath} (build the dsh-web tree first)`);
		}
		const rev = shortHash(new Uint8Array(await bundle.arrayBuffer()));
		table.set(id, { entry: graphRow(id, rev, decl), clientPath });
	}
	const entries = orderByModuleGraph([...table.values()].map(record => record.entry));
	const batches = composeBatches(entries);
	const graph: WebBootGraph = {
		rev: shortHash(JSON.stringify({ entries, batches })),
		...(release !== undefined ? { release } : {}),
		entries,
		batches,
	};
	return { graph, table };
}
