#!/usr/bin/env bun
/**
 * Package the dsh-web browser runtime as a redistributable release tarball.
 *
 * Collects exactly what the web host reads at runtime (see
 * packages/web/src/boot/graph.ts + server/serve.ts): the Vite shell dist, and
 * for every BOOT_ROSTER package its package.json plus the `./client` export
 * bundle (and sourcemap when present). dsh-web source, node_modules and host
 * packages are excluded. The dsh MIT LICENSE and THIRD_PARTY_NOTICES ride
 * along, plus an OMP-WEB-MANIFEST.json provenance record.
 *
 * Usage: bun scripts/package-dsh-runtime.ts [--dsh-root <dir>] [--version <v>] [--out <dir>]
 *
 * Output: <out>/dsh-web-runtime-<version>.tar.gz + SHA256SUMS.txt
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import { BOOT_ROSTER } from "../packages/web/src/boot/graph";

const DSH_BASELINE = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";
const DSH_REPO = "https://github.com/deepseek-ai/deepseek-harness";

interface Args {
	dshRoot?: string;
	version: string;
	out: string;
}

function parseArgs(): Args {
	const argv = process.argv.slice(2);
	const args: Args = { version: "0.1.0", out: "dist-release" };
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		const value = argv[i + 1];
		if (value === undefined) throw new Error(`missing value for ${key}`);
		if (key === "--dsh-root") args.dshRoot = value;
		else if (key === "--version") args.version = value;
		else if (key === "--out") args.out = value;
		else throw new Error(`unknown argument ${key}`);
	}
	return args;
}

function resolveDshRoot(given: string | undefined): string {
	const candidates = [
		given,
		process.env.OMP_WEB_DSH_ROOT,
		path.join(process.cwd(), "dsh-web"),
		path.resolve(process.cwd(), "..", "dsh-web"),
	].filter((c): c is string => c !== undefined && c !== "");
	for (const candidate of candidates) {
		const resolved = path.resolve(candidate);
		if (existsSync(path.join(resolved, "apps", "web", "dist", "index.html"))) return resolved;
	}
	throw new Error("no built dsh-web tree found (pass --dsh-root or run scripts/setup-dsh-web.sh first)");
}

/** name → package dir, mirroring the graph.ts indexPackages glob. */
async function indexPackages(dshRoot: string): Promise<Map<string, string>> {
	const index = new Map<string, string>();
	const glob = new Bun.Glob("packages/*/*/package.json");
	for await (const rel of glob.scan({ cwd: dshRoot })) {
		const manifest = (await Bun.file(path.join(dshRoot, rel)).json()) as { name?: unknown };
		if (typeof manifest.name === "string") index.set(manifest.name, path.dirname(rel));
	}
	return index;
}

function clientExportOf(exportsField: unknown): string | undefined {
	if (typeof exportsField !== "object" || exportsField === null) return undefined;
	const entry = (exportsField as Record<string, unknown>)["./client"];
	if (typeof entry === "string") return entry;
	if (typeof entry === "object" && entry !== null) {
		const def = (entry as Record<string, unknown>).default;
		if (typeof def === "string") return def;
	}
	return undefined;
}

async function main(): Promise<void> {
	const args = parseArgs();
	const dshRoot = resolveDshRoot(args.dshRoot);
	console.log(`dsh root: ${dshRoot}`);

	const packages = await indexPackages(dshRoot);
	const files: string[] = [];
	let missing = 0;
	for (const id of BOOT_ROSTER) {
		const dir = packages.get(id);
		if (dir === undefined) {
			console.error(`  MISSING roster package: ${id}`);
			missing++;
			continue;
		}
		const manifest = (await Bun.file(path.join(dshRoot, dir, "package.json")).json()) as {
			exports?: unknown;
		};
		const clientRel = clientExportOf(manifest.exports);
		if (clientRel === undefined) {
			console.error(`  MISSING ./client export: ${id}`);
			missing++;
			continue;
		}
		files.push(path.join(dir, "package.json"), path.join(dir, clientRel));
		const mapRel = `${clientRel}.map`;
		if (existsSync(path.join(dshRoot, dir, mapRel))) files.push(path.join(dir, mapRel));
	}
	if (missing > 0) throw new Error(`${missing} roster package(s) incomplete — build the tree first`);

	// The Vite shell, wholesale.
	const distGlob = new Bun.Glob("**/*");
	for await (const rel of distGlob.scan({ cwd: path.join(dshRoot, "apps", "web", "dist") })) {
		files.push(path.join("apps", "web", "dist", rel));
	}
	for (const legal of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
		if (existsSync(path.join(dshRoot, legal))) files.push(legal);
	}

	const stage = path.join(args.out, `dsh-web-runtime-${args.version}`);
	await Bun.$`rm -rf ${stage}`;
	await Bun.$`mkdir -p ${stage}`;
	let copied = 0;
	for (const rel of files) {
		const dest = path.join(stage, rel);
		await Bun.$`mkdir -p ${path.dirname(dest)}`;
		await Bun.$`cp ${path.join(dshRoot, rel)} ${dest}`;
		copied++;
	}

	const manifest = {
		name: "dsh-web-runtime",
		version: args.version,
		builtAt: new Date().toISOString(),
		source: { repo: DSH_REPO, commit: DSH_BASELINE, license: "MIT" },
		overlay: { "@omp/client-settings": "dsh-overlay/packages/client/omp-settings (omp-web fork)" },
		rosterPackages: BOOT_ROSTER.length,
		fileCount: copied,
	};
	await Bun.write(path.join(stage, "OMP-WEB-MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);

	const tarball = path.join(args.out, `dsh-web-runtime-${args.version}.tar.gz`);
	await Bun.$`tar -czf ${tarball} -C ${stage} .`;
	await Bun.$`rm -rf ${stage}`;
	const sha = await Bun.$`sha256sum ${tarball}`.text();
	await Bun.write(path.join(args.out, "SHA256SUMS.txt"), sha);

	const size = (await Bun.file(tarball).stat()).size;
	console.log(`tarball: ${tarball} (${(size / 1024 / 1024).toFixed(1)} MiB, ${copied + 1} files)`);
	console.log(`sha256:  ${sha.trim()}`);
}

await main();
