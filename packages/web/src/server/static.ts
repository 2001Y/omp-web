/**
 * SPA dist serving and plugin-bundle serving.
 * Behavior port of `@deepseek-ai/dsh-host-frontend-static` and the
 * `ClientModuleRegistry` bundle route (see PROVENANCE.md in the omp-web
 * workspace root): a readable index renders at the dist root and the exact
 * index path, missing paths 404, traversal outside the root 403, non-GET/HEAD
 * 405, unknown extensions ship as octet-stream.
 */

import * as path from "node:path";

const HTML_MIME = "text/html; charset=utf-8";

const MIME: Record<string, string> = {
	".html": HTML_MIME,
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".json": "application/json",
	".map": "application/json",
	".webmanifest": "application/manifest+json",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".png": "image/png",
	".txt": "text/plain; charset=utf-8",
};

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param method - request method.
 * @param distRoot - absolute dist root directory.
 * @param distIndex - absolute path of index.html inside the dist root.
 * @param renderIndex - produces the rendered index.html body.
 * @returns the response (405 for non-GET/HEAD).
 */
export async function serveStatic(
	pathname: string,
	method: string,
	distRoot: string,
	distIndex: string,
	renderIndex: () => Promise<string>,
): Promise<Response> {
	if (method !== "GET" && method !== "HEAD") {
		return new Response(null, { status: 405 });
	}
	const target = path.resolve(path.normalize(path.join(distRoot, pathname)));
	if (target !== distRoot && !target.startsWith(`${distRoot}${path.sep}`)) {
		return new Response(null, { status: 403 });
	}
	if (target === distRoot || target === distIndex) {
		const body = await renderIndex();
		return new Response(method === "HEAD" ? null : body, { status: 200, headers: { "content-type": HTML_MIME } });
	}
	const file = Bun.file(target);
	if (!(await file.exists())) {
		return new Response(null, { status: 404 });
	}
	return new Response(method === "HEAD" ? null : file, {
		status: 200,
		headers: { "content-type": MIME[path.extname(target)] ?? "application/octet-stream" },
	});
}
