import { afterEach, describe, expect, test } from "bun:test";
import { composeBootGraph, orderByModuleGraph, stripClientSuffix, type WebBootEntry } from "../src/boot/graph";
import { buildFixtureTree, type FixtureTree } from "./helpers";

const TREES: FixtureTree[] = [];

afterEach(async () => {
	await Promise.all(TREES.splice(0).map(tree => tree.cleanup()));
});

function entry(id: string, external?: string[]): WebBootEntry {
	return { id, url: `/plugins/${id}/client.js?rev=x`, rev: "x", ...(external !== undefined ? { external } : {}) };
}

describe("orderByModuleGraph", () => {
	test("a requested dynamic package precedes its consumers", () => {
		const ordered = orderByModuleGraph([entry("consumer", ["@deepseek-ai/dsh-dep"]), entry("@deepseek-ai/dsh-dep")]);
		expect(ordered.map(row => row.id)).toEqual(["@deepseek-ai/dsh-dep", "consumer"]);
	});

	test("a `<pkg>/client` subpath request resolves to the package's own row", () => {
		const ordered = orderByModuleGraph([
			entry("consumer", ["@deepseek-ai/dsh-dep/client"]),
			entry("@deepseek-ai/dsh-dep"),
		]);
		expect(ordered.map(row => row.id)).toEqual(["@deepseek-ai/dsh-dep", "consumer"]);
	});

	test("a module graph cycle fails loudly naming the packages on it", () => {
		expect(() => orderByModuleGraph([entry("a", ["b"]), entry("b", ["a"])])).toThrow(/cycle a -> b -> a/);
	});

	test("a row requesting itself is rejected", () => {
		expect(() => orderByModuleGraph([entry("a", ["a"])]).toString()).toThrow();
		expect(() => orderByModuleGraph([entry("a", ["a/client"])])).toThrow(/answers itself/);
	});
});

describe("stripClientSuffix", () => {
	test("strips only a trailing /client", () => {
		expect(stripClientSuffix("@deepseek-ai/dsh-x/client")).toBe("@deepseek-ai/dsh-x");
		expect(stripClientSuffix("@deepseek-ai/dsh-x")).toBe("@deepseek-ai/dsh-x");
	});
});

describe("composeBootGraph", () => {
	test("composes roster packages into rev-hashed, module-graph-ordered entries", async () => {
		const tree = await buildFixtureTree([
			{ id: "@deepseek-ai/dsh-client-ui-demo", external: ["@deepseek-ai/dsh-client-modules"] },
			{ id: "@deepseek-ai/dsh-client-modules" },
			{ id: "@deepseek-ai/dsh-client-runtime", immediately: true },
		]);
		TREES.push(tree);
		const { graph, table } = await composeBootGraph(tree.root, [
			"@deepseek-ai/dsh-client-ui-demo",
			"@deepseek-ai/dsh-client-modules",
			"@deepseek-ai/dsh-client-runtime",
		]);
		expect(graph.entries.map(row => row.id)).toEqual([
			"@deepseek-ai/dsh-client-modules",
			"@deepseek-ai/dsh-client-ui-demo",
			"@deepseek-ai/dsh-client-runtime",
		]);
		const demo = graph.entries.find(row => row.id === "@deepseek-ai/dsh-client-ui-demo");
		expect(demo?.url).toMatch(/^\/plugins\/@deepseek-ai\/dsh-client-ui-demo\/client.js\?rev=[0-9a-f]{12}$/);
		expect(demo?.external).toEqual(["@deepseek-ai/dsh-client-modules"]);
		const runtime = graph.entries.find(row => row.id === "@deepseek-ai/dsh-client-runtime");
		expect(runtime?.immediately).toBe(true);
		expect(graph.rev).toMatch(/^[0-9a-f]{12}$/);
		expect(table.get("@deepseek-ai/dsh-client-modules")?.clientPath).toBe(
			`${tree.root}/packages/client/modules/lib/client.js`,
		);
	});

	test("a roster package missing a built bundle fails naming the path", async () => {
		const tree = await buildFixtureTree([{ id: "@deepseek-ai/dsh-client-modules" }]);
		TREES.push(tree);
		await Bun.write(`${tree.root}/packages/client/modules/lib/client.js`, "");
		const fs = await import("node:fs/promises");
		await fs.rm(`${tree.root}/packages/client/modules/lib/client.js`);
		expect(composeBootGraph(tree.root, ["@deepseek-ai/dsh-client-modules"])).rejects.toThrow(
			/client bundle not found/,
		);
	});
});
