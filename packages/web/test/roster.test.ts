import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { deriveBootRoster, evaluateDisabled, parsePatchRows } from "../src/boot/roster";

const TEMP_DIRS: string[] = [];

afterEach(async () => {
	await Promise.all(TEMP_DIRS.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("evaluateDisabled", () => {
	test("literals pass through; profile comparisons evaluate; the rest stay unevaluated", () => {
		expect(evaluateDisabled("true", "web")).toBe(true);
		expect(evaluateDisabled("false", "web")).toBe(false);
		expect(evaluateDisabled(`!!js "ctx.get('profileContext')?.name !== 'desktop'"`, "web")).toBe(true);
		expect(evaluateDisabled(`!!js "ctx.get('profileContext')?.name !== 'desktop'"`, "desktop")).toBe(false);
		expect(evaluateDisabled(`!!js "ctx.get('profileContext')?.name === 'desktop'"`, "web")).toBe(false);
		expect(evaluateDisabled("!!js process.env.SOMETHING", "web")).toBeUndefined();
	});
});

describe("parsePatchRows", () => {
	test("insert rows, overrides, and quoted names extract in order", () => {
		const rows = parsePatchRows(
			[
				"- insert:",
				"    - id: modules",
				"      name: '@deepseek-ai/dsh-client-modules'",
				"    - id: telemetry",
				"      name: '@deepseek-ai/dsh-client-product-analytics'",
				`      disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"`,
				"- id: modules",
				"  disabled: true",
			].join("\n"),
			"web",
		);
		expect(rows).toEqual([
			{ id: "modules", name: "@deepseek-ai/dsh-client-modules" },
			{ id: "telemetry", name: "@deepseek-ai/dsh-client-product-analytics", disabled: true },
			{ id: "modules", disabled: true },
		]);
	});
});

describe("deriveBootRoster", () => {
	test("a tree without bundle patches derives nothing (the caller falls back)", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-roster-"));
		TEMP_DIRS.push(dir);
		expect(await deriveBootRoster(dir)).toBeUndefined();
	});

	test("the dsh 0.2.1-rc.2 patch layers derive the web roster with exclusions applied", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-roster-"));
		TEMP_DIRS.push(dir);
		const fixture = path.join(import.meta.dir, "fixtures", "bundle");
		for (const bundle of ["base", "web-app"]) {
			const target = path.join(dir, "packages", "bundle", bundle);
			await fs.mkdir(path.join(target, "presets"), { recursive: true });
			await fs.copyFile(path.join(fixture, bundle, "package.json"), path.join(target, "package.json"));
			await fs.copyFile(path.join(fixture, bundle, "cordis.patch.yml"), path.join(target, "cordis.patch.yml"));
		}
		for (const preset of ["standard.patch.yml", "ptc.patch.yml", "minimal.patch.yml", "cordis.patch.yml"]) {
			await fs.copyFile(
				path.join(fixture, "web-app", "presets", preset),
				path.join(dir, "packages", "bundle", "web-app", "presets", preset),
			);
		}
		const roster = await deriveBootRoster(dir);
		if (roster === undefined) throw new Error("expected a derived roster");
		// Core browser rows are present, overlay last.
		expect(roster).toContain("@deepseek-ai/dsh-client-modules");
		expect(roster).toContain("@deepseek-ai/dsh-client-connection");
		expect(roster).toContain("@deepseek-ai/dsh-client-ui-session");
		expect(roster.at(-1)).toBe("@omp/client-settings");
		expect(roster.at(-2)).toBe("@omp/client-brand");
		// The browse directory picker is pinned: the patch layers only name
		// the host-side -auto package, and without the face the workspace
		// picker's directory-flow holes stay empty (Choose workspace would
		// offer no way to adopt a directory on a fresh profile).
		expect(roster).toContain("@deepseek-ai/dsh-client-ui-directory-picker-browse");
		// Host exclusions and profile-disabled rows are absent.
		expect(roster).not.toContain("@deepseek-ai/dsh-client-hmr");
		expect(roster).not.toContain("@deepseek-ai/dsh-client-ui-message-feedback");
		expect(roster).not.toContain("@deepseek-ai/dsh-client-product-analytics");
		expect(roster).not.toContain("@deepseek-ai/dsh-host-product-telemetry-otel");
		// No duplicates survive layering.
		expect(new Set(roster).size).toBe(roster.length);
	});
});
