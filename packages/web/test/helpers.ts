/**
 * Shared fixture builder for the web host contract tests: a synthetic vendored
 * dsh-web tree with the minimal shape `composeBootGraph` and the server read
 * (roster packages declaring `dsh.client` web halves with built bundles, plus
 * an apps/web dist with an index.html).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/** One fixture plugin package: manifest declaration plus built bundle bytes. */
export interface FixturePlugin {
	id: string;
	/** Directory under `packages/<group>/`; defaults to `client`. */
	group?: string;
	external?: string[];
	immediately?: boolean;
	bundle?: string;
}

/** The synthetic roster tree plus the paths the server needs. */
export interface FixtureTree {
	root: string;
	distIndex: string;
	cleanup: () => Promise<void>;
}

const DIST_INDEX_HTML = [
	"<!doctype html>",
	'<html lang="en">',
	"  <head>",
	'    <meta charset="utf-8" />',
	"    <title>fixture</title>",
	'    <script type="module" src="/assets/index-fixture.js"></script>',
	"  </head>",
	"  <body>",
	'    <div id="root"></div>',
	"  </body>",
	"</html>",
].join("\n");

/**
 * Materialize a synthetic vendored tree carrying every fixture plugin.
 * @param plugins - roster packages to create.
 * @returns the tree paths and a cleanup disposer.
 */
export async function buildFixtureTree(plugins: readonly FixturePlugin[]): Promise<FixtureTree> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-web-test-"));
	for (const plugin of plugins) {
		// Mirror the vendored tree's directory naming: the scoped package name
		// without the common `dsh-client-` prefix (packages/client/modules, …).
		const leaf = plugin.id.replace(/^@[^/]+\//, "").replace(/^dsh-client-/, "");
		const dir = path.join(root, "packages", plugin.group ?? "client", leaf);
		await fs.mkdir(path.join(dir, "lib"), { recursive: true });
		const manifest = {
			name: plugin.id,
			type: "module",
			exports: {
				".": "./lib/index.js",
				"./client": "./lib/client.js",
			},
			dsh: {
				client: {
					platform: "web",
					...(plugin.external !== undefined ? { external: plugin.external } : {}),
					...(plugin.immediately === true ? { immediately: true } : {}),
				},
			},
		};
		await Bun.write(path.join(dir, "package.json"), JSON.stringify(manifest));
		await Bun.write(path.join(dir, "lib", "client.js"), plugin.bundle ?? `// ${plugin.id} bundle\n`);
		await Bun.write(path.join(dir, "lib", "client.js.map"), JSON.stringify({ version: 3, sources: [] }));
	}
	const distDir = path.join(root, "apps", "web", "dist");
	await fs.mkdir(path.join(distDir, "assets"), { recursive: true });
	await Bun.write(path.join(distDir, "index.html"), DIST_INDEX_HTML);
	await Bun.write(path.join(distDir, "assets", "index-fixture.js"), "export {}\n");
	return {
		root,
		distIndex: path.join(distDir, "index.html"),
		cleanup: async () => {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}
