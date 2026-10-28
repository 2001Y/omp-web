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

/** Document region a rendered row lands in: after the opening head/body tag, or before the closing body tag. */
export type IndexInjectionPlacement = "head" | "body" | "body-end";

/** One structured index injection row. */
export type IndexInjection =
	/** Assign a JSON-serializable value to a `globalThis` property, ahead of later script rows. */
	| { kind: "global"; name: string; value: unknown }
	/** Inline classic script. `text` must not contain `</script`. */
	| { kind: "script"; placement: IndexInjectionPlacement; text: string }
	/** External classic script, executed in table order. */
	| { kind: "script-src"; placement: IndexInjectionPlacement; src: string }
	/** A `<link rel="preload" as="script">` fetch hint in the head. */
	| { kind: "script-preload"; src: string }
	/** A `<style>` element in the head. */
	| { kind: "style"; text: string }
	/** Raw markup fragment. */
	| { kind: "html"; placement: IndexInjectionPlacement; html: string };

/** Bootstrap package whose ordinary client bundle supplies the module-system implementation. */
const CLIENT_MODULES_ID = "@deepseek-ai/dsh-client-modules";

/** Body-end script resolving the boot-ready deferred the client entry awaits before reading boot state. */
const BOOT_READY_SCRIPT = "(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()";

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
		case "script-preload":
			return { placement: "head", markup: `<link rel="preload" as="script" href="${row.src}">` };
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
	let bodyEnd = "";
	for (const row of rows) {
		const rendered = renderRow(row);
		if (rendered.placement === "head") head += rendered.markup;
		else if (rendered.placement === "body") body += rendered.markup;
		else bodyEnd += rendered.markup;
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
	if (bodyEnd !== "") {
		const close = /<\/body\s*>/i.exec(out);
		out = close === null ? `${out}${bodyEnd}` : splice(out, close.index, bodyEnd);
	}
	return out;
}

/**
 * The boot protocol as index injection rows (dsh 0.2.x): the inline
 * registration queue precedes the application batches' preload hints and
 * the bootstrap batch's parser-blocking script; the graph global follows
 * before the shell reads it, and a body-end script resolves the boot-ready
 * deferred the client entry awaits.
 * @param graph - the composed entry graph.
 * @returns rows in protocol order: queue script, application preloads,
 * bootstrap script, graph global, boot-ready resolution.
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
	const preloads = graph.batches
		.filter(batch => batch.phase === "application")
		.map((batch): IndexInjection => ({ kind: "script-preload", src: batch.url }));
	const bootstrap = graph.batches
		.filter(batch => batch.phase === "bootstrap")
		.map((batch): IndexInjection => ({ kind: "script-src", placement: "head", src: batch.url }));
	return [
		{ kind: "script", placement: "head", text: queue },
		...preloads,
		...bootstrap,
		{ kind: "global", name: "__DSH_BOOT__", value: graph },
		{ kind: "script", placement: "body-end", text: BOOT_READY_SCRIPT },
	];
}
