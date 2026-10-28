import { describe, expect, test } from "bun:test";
import type { WebBootGraph } from "../src/boot/graph";
import { bootInjections, renderIndexInjections } from "../src/boot/inject";

describe("renderIndexInjections", () => {
	const html = [
		"<html>",
		"  <head>",
		'    <meta charset="utf-8" />',
		"  </head>",
		"  <body>",
		"  </body>",
		"</html>",
	].join("\n");

	test("head rows land after the opening head tag, body rows after the opening body tag", () => {
		const out = renderIndexInjections(html, [
			{ kind: "script-src", placement: "head", src: "/plugins/a/client.js?rev=1" },
			{ kind: "html", placement: "body", html: "<div>x</div>" },
		]);
		const head = out.indexOf("<head>");
		const preload = out.indexOf('<script src="/plugins/a/client.js?rev=1"></script>');
		const body = out.indexOf("<body>");
		const fragment = out.indexOf("<div>x</div>");
		expect(preload).toBeGreaterThan(head);
		expect(preload).toBeLessThan(body);
		expect(fragment).toBeGreaterThan(body);
	});

	test("a global row escapes < so a row-controlled string cannot break out of the script element", () => {
		const out = renderIndexInjections(html, [{ kind: "global", name: "__X__", value: "</script><script>alert(1)" }]);
		expect(out).not.toContain("</script><script>alert(1)");
		expect(out).toContain('globalThis["__X__"]');
	});

	test("html without a head receives head rows ahead of every document script", () => {
		const out = renderIndexInjections("<body></body>", [{ kind: "script", placement: "head", text: "var a=1" }]);
		expect(out.indexOf("<script>var a=1</script>")).toBe(0);
	});
});

describe("bootInjections", () => {
	const graph: WebBootGraph = {
		rev: "abc123",
		entries: [
			{ id: "@deepseek-ai/dsh-client-modules", url: "plugins/??m/client.js&rev=1", rev: "1" },
			{ id: "@deepseek-ai/dsh-client-runtime", url: "plugins/??r/client.js&rev=2", rev: "2" },
			{ id: "@deepseek-ai/dsh-client-ui-demo", url: "plugins/??d/client.js&rev=3", rev: "3" },
		],
		batches: [
			{ phase: "bootstrap", url: "plugins/??m/client.js&rev=b1", rev: "b1", entries: ["@deepseek-ai/dsh-client-modules"] },
			{
				phase: "application",
				url: "plugins/??r/client.js,d/client.js&rev=b2",
				rev: "b2",
				entries: ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-demo"],
			},
		],
	};

	test("rows are queue script, application preload, bootstrap script, graph global, access baseline, boot-ready", () => {
		const rows = bootInjections(graph);
		expect(rows).toHaveLength(6);
		expect(rows[0]).toMatchObject({ kind: "script" });
		expect(rows[0].kind === "script" && rows[0].text).toContain("window.__ModuleLoader__");
		expect(rows[1]).toMatchObject({ kind: "script-preload", src: "plugins/??r/client.js,d/client.js&rev=b2" });
		expect(rows[2]).toMatchObject({ kind: "script-src", src: "plugins/??m/client.js&rev=b1" });
		expect(rows[3]).toMatchObject({ kind: "global", name: "__DSH_BOOT__", value: graph });
		expect(rows[4]).toMatchObject({ kind: "global", name: "__DSH_REMOTE_ACCESS__", value: { type: "baseline", owner: true } });
		expect(rows[5]).toMatchObject({ kind: "script", placement: "body-end" });
		expect(rows[5].kind === "script" && rows[5].text).toContain("__DSH_BOOT_READY__");
	});

	test("the graph global survives the full index render verbatim, and boot-ready lands before </body>", () => {
		const out = renderIndexInjections("<html><head></head><body><main></main></body></html>", bootInjections(graph));
		expect(out).toContain('globalThis["__DSH_BOOT__"] = {"rev":"abc123"');
		const ready = out.indexOf("__DSH_BOOT_READY__");
		expect(ready).toBeGreaterThan(out.indexOf("</main>"));
		expect(ready).toBeLessThan(out.indexOf("</body>"));
		// The application batch is a preload hint, not an executing script.
		expect(out).toContain('<link rel="preload" as="script" href="plugins/??r/client.js,d/client.js&rev=b2">');
	});
});
