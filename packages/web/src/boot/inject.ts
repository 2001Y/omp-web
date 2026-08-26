/**
 * Structured index.html injections for the boot page.
 *
 * Behavior port of `@deepseek-ai/dsh-host-webserver` `injections.ts` and of
 * the `bootInjections` rows from the `@deepseek-ai/dsh-client-modules` node
 * half (see PROVENANCE.md in the omp-web workspace root): the inline
 * `__ModuleLoader__` queue script and the parser-blocking preloads are wire
 * protocol the browser shell parses verbatim, so they are mirrored exactly.
 */

import type { WebBootGraph } from "./graph";

/** Document region a rendered row lands in: after the opening head or body tag. */
export type IndexInjectionPlacement = "head" | "body";

/** One structured index injection row. */
export type IndexInjection =
	/** Assign a JSON-serializable value to a `globalThis` property, ahead of later script rows. */
	| { kind: "global"; name: string; value: unknown }
	/** Inline classic script. `text` must not contain `</script`. */
	| { kind: "script"; placement: IndexInjectionPlacement; text: string }
	/** External classic script, executed in table order. */
	| { kind: "script-src"; placement: IndexInjectionPlacement; src: string }
	/** A `<style>` element in the head. */
	| { kind: "style"; text: string }
	/** Raw markup fragment. */
	| { kind: "html"; placement: IndexInjectionPlacement; html: string };

/** Bootstrap package whose ordinary client bundle supplies the module-system implementation. */
const CLIENT_MODULES_ID = "@deepseek-ai/dsh-client-modules";

/** Dynamic package whose ordinary client bundle must be registered before plugin boot starts. */
const CLIENT_RUNTIME_ID = "@deepseek-ai/dsh-client-runtime";

/** Ordinary dynamic bundles the HTML parser executes before the Vite shell. */
const PARSER_PRELOAD_IDS = [CLIENT_MODULES_ID, CLIENT_RUNTIME_ID] as const;

/** Render one row to markup with its placement. */
function renderRow(row: IndexInjection): { placement: IndexInjectionPlacement; markup: string } {
	switch (row.kind) {
		case "global": {
			// `<` is escaped in JSON so a row-controlled string cannot break out of the script element.
			const name = JSON.stringify(row.name).replaceAll("<", "\\u003c");
			const value = row.value === undefined ? "undefined" : JSON.stringify(row.value).replaceAll("<", "\\u003c");
			return { placement: "head", markup: `<script>globalThis[${name}] = ${value}</script>` };
		}
		case "script":
			return { placement: row.placement, markup: `<script>${row.text}</script>` };
		case "script-src":
			return { placement: row.placement, markup: `<script src="${row.src}"></script>` };
		case "style":
			return { placement: "head", markup: `<style>${row.text}</style>` };
		case "html":
			return { placement: row.placement, markup: row.html };
	}
}

/** Insert `markup` into `html` at `at`. */
function splice(html: string, at: number, markup: string): string {
	return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}

/**
 * Render rows into an index.html body: head rows immediately after the opening
 * head tag, body rows immediately after the opening body tag, each group in
 * table order.
 * @param html - the raw index.html body.
 * @param rows - the collected injection table.
 * @returns the html with every row rendered.
 */
export function renderIndexInjections(html: string, rows: readonly IndexInjection[]): string {
	let head = "";
	let body = "";
	for (const row of rows) {
		const rendered = renderRow(row);
		if (rendered.placement === "head") head += rendered.markup;
		else body += rendered.markup;
	}
	let out = html;
	if (head !== "") {
		const open = /<head(?:\s[^>]*)?>/i.exec(out);
		out = open === null ? `${head}${out}` : splice(out, open.index + open[0].length, head);
	}
	if (body !== "") {
		const open = /<body(?:\s[^>]*)?>/i.exec(out);
		out = open === null ? `${out}${body}` : splice(out, open.index + open[0].length, body);
	}
	return out;
}

/**
 * The boot protocol as index injection rows: the inline registration queue
 * precedes blocking classic scripts for modules' and runtime's ordinary
 * `lib/client.js` artifacts, and the graph global follows before the shell
 * reads it.
 * @param graph - the composed entry graph.
 * @returns head rows in execution order: queue script, preload scripts, graph global.
 */
export function bootInjections(graph: WebBootGraph): IndexInjection[] {
	const bootstrapId = JSON.stringify(CLIENT_MODULES_ID);
	const queue = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${bootstrapId})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()`;
	const preload = PARSER_PRELOAD_IDS.map(id => graph.entries.find(entry => entry.id === id))
		.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
		.map((entry): IndexInjection => ({ kind: "script-src", placement: "head", src: entry.url }));
	return [
		{ kind: "script", placement: "head", text: queue },
		...preload,
		{ kind: "global", name: "__DSH_BOOT__", value: graph },
	];
}
