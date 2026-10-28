/**
 * Boot-roster derivation from the vendored tree's own bundle patches.
 *
 * The dsh web profile's plugin set is data, not code: the layered
 * `cordis.patch.yml` files named by each bundle package's
 * `dsh.bundle.patch` (base first, then web-app and its presets). This
 * module extracts the insert rows' package names in layer order so the
 * boot roster follows the vendored baseline automatically instead of
 * being a hand-copied list that silently rots. Client-face filtering
 * stays in the graph composer (a row joins the boot graph only when its
 * package actually declares `dsh.client` and ships a built bundle).
 *
 * The patch files use `!!js` expression tags, so this is a narrow
 * line-oriented extractor for the row grammar (`- id:` / `name:` /
 * `disabled:`), not a general YAML parser. `disabled` expressions are
 * evaluated only for the profile-name comparison family; anything else
 * is treated as enabled and reported through the row record.
 */

/** One extracted patch row. Override rows may carry only a `disabled` cell. */
export interface PatchRow {
	/** Loader row id (the layering key: later layers replace earlier rows). */
	id: string;
	/** Package name the row loads; absent on override-only rows. */
	name?: string;
	/** Disabled state for the target profile; undefined when the row carries no `disabled` cell. */
	disabled?: boolean;
	/** The raw `disabled` expression when it could not be evaluated. */
	disabledUnevaluated?: string;
}

/** Packages this host deliberately keeps out of the boot graph, with the reason. */
export const BOOT_ROSTER_EXCLUSIONS: ReadonlyArray<{ name: string; reason: string }> = [
	{
		name: "@deepseek-ai/dsh-client-hmr",
		reason: "dev-only hot-reload plugin; its /plugins/events EventSource is not served by this host",
	},
	{
		name: "@deepseek-ai/dsh-client-ui-message-feedback",
		reason:
			"its thumbs affordance writes through messageFeedback/* endpoints this host does not serve " +
			"(no feedback telemetry exists in OMP); rostering it would mount a dead control on every assistant message",
	},
];

/** The fork's own overlay packages, appended to every derived roster (brand first, settings last). */
export const OVERLAY_PACKAGES: readonly string[] = ["@omp/client-brand", "@omp/client-settings"];

/** Bundle packages whose patch layers compose the web profile, in layer order. */
const BUNDLE_DIRS = ["packages/bundle/base", "packages/bundle/web-app"] as const;

function unquote(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith("'") && trimmed.endsWith("'")) ||
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/**
 * Evaluate a `disabled` cell for one profile. Literal booleans pass
 * through; `!!js` expressions resolve only for the profile-name
 * comparison family (`ctx.get('profileContext')?.name !== 'x'` and its
 * `===` twin). Anything else returns undefined (unevaluated).
 */
export function evaluateDisabled(raw: string, profileName: string): boolean | undefined {
	const value = raw.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	const notEqual = /profileContext'\)\?\.name\s*!==\s*'([^']+)'/.exec(value);
	if (notEqual !== null) return profileName !== notEqual[1];
	const equal = /profileContext'\)\?\.name\s*===\s*'([^']+)'/.exec(value);
	if (equal !== null) return profileName === equal[1];
	return undefined;
}

/**
 * Extract the rows of one patch file's text: every `- insert:` block's
 * entries plus top-level `- id:` override rows, in file order.
 * @param text - the patch file contents.
 * @param profileName - the profile `disabled` expressions evaluate against.
 * @returns rows keyed in encounter order (ids may repeat across layers).
 */
export function parsePatchRows(text: string, profileName: string): PatchRow[] {
	const rows: PatchRow[] = [];
	let current: { id: string; name?: string; disabledRaw?: string } | undefined;
	const flush = (): void => {
		if (current === undefined) return;
		// Structural rows (e.g. `name: cordis:group` with nested config
		// children) are not packages: npm names never contain ":". Their
		// nested rows are parsed as rows of their own, so dropping the
		// group row loses nothing.
		if (current.name !== undefined && current.name.includes(":")) {
			current = undefined;
			return;
		}
		if (current.name !== undefined || current.disabledRaw !== undefined) {
			const evaluated =
				current.disabledRaw === undefined ? undefined : evaluateDisabled(current.disabledRaw, profileName);
			rows.push({
				id: current.id,
				...(current.name !== undefined ? { name: current.name } : {}),
				...(evaluated !== undefined ? { disabled: evaluated } : {}),
				...(evaluated === undefined && current.disabledRaw !== undefined
					? { disabledUnevaluated: current.disabledRaw }
					: {}),
			});
		}
		current = undefined;
	};
	for (const line of text.split("\n")) {
		const rowStart = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
		if (rowStart !== null) {
			flush();
			current = { id: rowStart[1] as string };
			continue;
		}
		if (/^-\s/.test(line) || /^\s*-\s+insert:\s*$/.test(line)) {
			// A new top-level item (or the insert opener itself, whose first
			// row start follows) closes any row being accumulated.
			if (!/^\s/.test(line)) flush();
			continue;
		}
		if (current === undefined) continue;
		const name = /^\s+name:\s*(.+?)\s*$/.exec(line);
		if (name !== null && current.name === undefined) {
			current.name = unquote(name[1] as string);
			continue;
		}
		const disabled = /^\s+disabled:\s*(.+?)\s*$/.exec(line);
		if (disabled !== null && current.disabledRaw === undefined) {
			current.disabledRaw = disabled[1] as string;
		}
	}
	flush();
	return rows;
}

/**
 * Derive the candidate boot roster from the vendored tree's bundle
 * patches: layer-ordered package names with disabled rows dropped,
 * this host's exclusions removed, and the overlay package appended.
 * @param dshRoot - the vendored dsh tree root.
 * @param profileName - profile the roster is for (default `web`).
 * @returns the roster, or undefined when the tree carries no bundle patches
 * (a legacy or fixture tree, where the caller falls back to its own list).
 */
export async function deriveBootRoster(dshRoot: string, profileName = "web"): Promise<string[] | undefined> {
	const byId = new Map<string, PatchRow>();
	let sawPatch = false;
	for (const bundleDir of BUNDLE_DIRS) {
		const manifestFile = Bun.file(`${dshRoot}/${bundleDir}/package.json`);
		if (!(await manifestFile.exists())) continue;
		const manifest = (await manifestFile.json()) as { dsh?: { bundle?: { patch?: string | string[] } } };
		const patches = manifest.dsh?.bundle?.patch;
		const files = patches === undefined ? [] : Array.isArray(patches) ? patches : [patches];
		for (const file of files) {
			const patchFile = Bun.file(`${dshRoot}/${bundleDir}/${file.replace(/^\.\//, "")}`);
			if (!(await patchFile.exists())) continue;
			sawPatch = true;
			for (const row of parsePatchRows(await patchFile.text(), profileName)) {
				const prior = byId.get(row.id);
				if (prior === undefined) {
					byId.set(row.id, row);
					continue;
				}
				// Later layers restate or amend the row: a name replaces, a
				// `disabled` cell overrides, and either may arrive alone.
				byId.set(row.id, {
					id: row.id,
					name: row.name ?? prior.name,
					disabled: row.disabled ?? prior.disabled,
					...(row.disabledUnevaluated ?? prior.disabledUnevaluated
						? { disabledUnevaluated: row.disabledUnevaluated ?? prior.disabledUnevaluated }
						: {}),
				});
			}
		}
	}
	if (!sawPatch) return undefined;
	const excluded = new Set(BOOT_ROSTER_EXCLUSIONS.map(entry => entry.name));
	const roster: string[] = [];
	const seen = new Set<string>();
	for (const row of byId.values()) {
		if (row.name === undefined || row.disabled === true || excluded.has(row.name) || seen.has(row.name)) continue;
		seen.add(row.name);
		roster.push(row.name);
	}
	roster.push(...OVERLAY_PACKAGES);
	return roster;
}
