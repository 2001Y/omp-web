/**
 * The omp web GUI host (dsh 0.2.x surface): one Bun.serve assembling the
 * vendored dsh browser stack — boot-graph-injected index behind launch-token
 * authentication, plugin bundles (single and combo form), the Typert Remote
 * unary surface (`POST /api/<namespace>/<method>`), the bidirectional
 * stream mux (`/api/remote.mux`), and the exact fetch routes. Pure glue per
 * the omp-web fork rules: no presentation code lives here — every visual
 * byte comes from the vendored client stack.
 */

import * as os from "node:os";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { type ComposedBoot, composeBootGraph } from "../boot/graph";
import { bootInjections, renderIndexInjections } from "../boot/inject";
import type { WebDriver } from "../protocol/driver";
import { BrowserAuth, loadOrCreateAuthSecret } from "../remote/auth";
import { RemoteStreams } from "../remote/streams";
import { createRemoteDispatcher } from "../remote/unary";
import { remoteError, type ServerResponse } from "../remote/wire";
import { serveStatic } from "./static";
import { isTrustedApiRequest } from "./trust";
import { buildZip } from "./zip";

/** Route prefix owning every api request. */
const API_PATH = "/api";

/** Bidirectional stream mux pathname. */
const MUX_PATH = `${API_PATH}/remote.mux`;

/** Default listen port (dsh serves 3080; omp takes a neighbor to coexist). */
const DEFAULT_PORT = 3180;

/** Server assembly options. */
export interface WebServerOptions {
	/** The injected backend (implemented by the coding agent's web mode). */
	driver: WebDriver;
	/** Absolute path of the vendored dsh-web checkout. */
	dshRoot: string;
	/** Listen host; defaults to loopback. */
	hostname?: string;
	/** Listen port; zero requests an OS-assigned port. */
	port?: number;
	/** Non-loopback authorities this server is reached by (DNS-rebinding fence). */
	trustedHosts?: string[];
	/** Browser roster override; defaults to the full dsh web profile roster. */
	roster?: readonly string[];
	/** Auth-secret file; defaults to `~/.omp/agent/web-auth.key`. */
	authSecretPath?: string;
}

/** Running server handle. */
export interface WebServerHandle {
	/** The canonical local URL (no credentials). */
	url: string;
	/** The first-visit URL carrying the launch token (redeems into a cookie). */
	accessUrl: string;
	/** The bound port (the OS-assigned value when zero was requested). */
	port: number;
	/** Stops accepting requests, terminates sockets, and resolves. */
	stop: () => Promise<void>;
}

/** Per-socket state Bun hands through `server.upgrade` (the mux carries none). */
interface MuxSocketData {
	kind: "remote-mux";
}

/** Compose the boot graph and pre-render the index once per server lifetime. */
async function prepareBootAssets(
	dshRoot: string,
	roster: readonly string[] | undefined,
): Promise<{ boot: ComposedBoot; indexHtml: string }> {
	const distIndex = path.join(dshRoot, "apps", "web", "dist", "index.html");
	const distIndexFile = Bun.file(distIndex);
	if (!(await distIndexFile.exists())) {
		throw new Error(`omp-web: frontend dist not found at ${distIndex} (build the dsh-web tree first)`);
	}
	const boot = await composeBootGraph(dshRoot, roster);
	const rawIndex = await distIndexFile.text();
	return { boot, indexHtml: renderIndexInjections(rawIndex, bootInjections(boot.graph)) };
}

/**
 * Start the web GUI host.
 * @param options - assembly options; `driver` and `dshRoot` are required.
 * @returns the running server handle.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
	const hostname = options.hostname ?? "127.0.0.1";
	const port = options.port ?? DEFAULT_PORT;
	const trustedHosts = options.trustedHosts ?? [];
	const { boot, indexHtml } = await prepareBootAssets(options.dshRoot, options.roster);
	const secretPath = options.authSecretPath ?? path.join(os.homedir(), ".omp", "agent", "web-auth.key");
	const auth = new BrowserAuth(await loadOrCreateAuthSecret(secretPath));
	const dispatcher = createRemoteDispatcher(options.driver);
	const streams = new RemoteStreams(options.driver);
	const distRoot = path.join(options.dshRoot, "apps", "web", "dist");
	const distIndex = path.join(distRoot, "index.html");

	const unsubscribe = options.driver.subscribe(notification => {
		try {
			streams.handleNotification(notification);
		} catch (error) {
			logger.warn(`omp-web: stream pump failure: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	const liveness = setInterval(() => streams.sweepLiveness(), 2000);

	const server = Bun.serve<MuxSocketData>({
		hostname,
		port,
		fetch: async (req: Request, srv: Bun.Server<MuxSocketData>): Promise<Response | undefined> => {
			try {
				return await handleRequest(req, srv);
			} catch (error) {
				// Last-resort guard: one malformed request must never kill the process.
				logger.warn(`omp-web: request failure: ${error instanceof Error ? error.message : String(error)}`);
				return new Response(null, { status: 400 });
			}
		},
		websocket: {
			open: (ws: Bun.ServerWebSocket<MuxSocketData>): void => {
				streams.attach(ws);
			},
			message: (ws: Bun.ServerWebSocket<MuxSocketData>, message: string | Buffer): void => {
				if (typeof message !== "string") {
					ws.close(1003, "text frames only");
					return;
				}
				void streams.handleMessage(ws, message);
			},
			pong: (ws: Bun.ServerWebSocket<MuxSocketData>): void => {
				streams.noteAlive(ws);
			},
			close: (ws: Bun.ServerWebSocket<MuxSocketData>): void => {
				streams.detach(ws);
			},
		},
	});

	const url = `http://${hostname}:${String(server.port)}`;
	return {
		url,
		accessUrl: `${url}/?token=${auth.launchToken}`,
		port: server.port ?? port,
		stop: async (): Promise<void> => {
			clearInterval(liveness);
			unsubscribe();
			streams.failAllAsks("omp-web: server stopped");
			server.stop(true);
		},
	};

	async function handleRequest(req: Request, srv: Bun.Server<MuxSocketData>): Promise<Response | undefined> {
		const requestUrl = new URL(req.url);
		const rawPathname = requestUrl.pathname;
		if (rawPathname === "/connect") return handleConnect(req, requestUrl);
		if (rawPathname === API_PATH || rawPathname.startsWith(`${API_PATH}/`)) {
			return handleApi(req, srv, rawPathname);
		}
		if (rawPathname === "/" || rawPathname === "/index.html") return handleIndex(req, requestUrl);
		if (auth.authenticate(req.headers) === undefined) {
			return new Response("unauthorized", { status: 401 });
		}
		if (rawPathname.startsWith("/plugins/")) {
			return handlePluginBundle(req, requestUrl);
		}
		if (rawPathname === "/open-in-app/apps") {
			// The ui-open-in-app probe: desktop applications this host could
			// open paths in. A headless host has none to offer.
			return Response.json({ apps: [] });
		}
		return serveStatic(decodeURIComponent(rawPathname), req.method, distRoot, distIndex, async () => indexHtml);
	}

	/** `GET /`: redeem a launch token into the signed cookie, else require the cookie. */
	function handleIndex(req: Request, requestUrl: URL): Response {
		const authority = req.headers.get("host") ?? "";
		const token = requestUrl.searchParams.get("token");
		if (auth.isLaunchToken(token)) {
			return new Response(null, {
				status: 303,
				headers: { location: "/", "set-cookie": auth.mintCookie(authority, 1) },
			});
		}
		if (auth.authenticate(req.headers) === undefined) {
			return new Response("unauthorized", { status: 401 });
		}
		return new Response(indexHtml, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
	}

	/** `GET /connect?token=…&interactions=…`: the v2 cookie for worker peers. */
	function handleConnect(req: Request, requestUrl: URL): Response {
		const authority = req.headers.get("host") ?? "";
		const token = requestUrl.searchParams.get("token");
		if (auth.isLaunchToken(token)) {
			return new Response(null, {
				status: 303,
				headers: { location: "/", "set-cookie": auth.mintCookie(authority, 2, crypto.randomUUID()) },
			});
		}
		if (auth.authenticate(req.headers) !== undefined) {
			return new Response(null, { status: 303, headers: { location: "/" } });
		}
		return new Response("unauthorized", { status: 401 });
	}

	async function handleApi(
		req: Request,
		srv: Bun.Server<MuxSocketData>,
		rawPathname: string,
	): Promise<Response | undefined> {
		if (!isTrustedApiRequest(req.headers, trustedHosts)) {
			return new Response("forbidden", { status: 403 });
		}
		if (auth.authenticate(req.headers) === undefined) {
			return new Response("unauthorized", { status: 401 });
		}
		if (rawPathname === `${API_PATH}/session.export`) {
			return handleSessionExport(req);
		}
		if (rawPathname === `${API_PATH}/session/uploadFileBinary` || rawPathname === `${API_PATH}/file`) {
			// Exact fetch routes this phase does not serve: an honest 404 lets
			// the client fold the feature instead of breaking on an envelope.
			return new Response(null, { status: 404 });
		}
		if (rawPathname === MUX_PATH) {
			if (req.method !== "GET") return new Response(null, { status: 405 });
			if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
				return new Response("upgrade required", {
					status: 426,
					headers: { connection: "Upgrade", upgrade: "websocket" },
				});
			}
			if (srv.upgrade(req, { data: { kind: "remote-mux" } })) return undefined;
			return new Response("upgrade failed", { status: 400 });
		}
		if (req.method !== "POST") {
			return new Response(null, { status: 405 });
		}
		const mediaType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		if (mediaType !== "application/json") {
			return new Response(null, { status: 415 });
		}
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return new Response(null, { status: 400 });
		}
		if (typeof body !== "object" || body === null || (body as { type?: unknown }).type !== "client-request") {
			return new Response(null, { status: 400 });
		}
		const request = body as { rpcId: string; method: string; payload: { args: Record<string, unknown> } };
		const endpoint = rawPathname.slice(API_PATH.length + 1);
		if (endpoint === "$events/result") {
			const accepted = streams.resolveEventResult(request.payload?.args ?? {});
			const response: ServerResponse = {
				type: "server-response",
				rpcId: request.rpcId,
				result: accepted
					? { ok: true, value: { accepted: true } }
					: { ok: false, error: remoteError("gateway/not-found", "omp-web: no pending ask for that event") },
			};
			return Response.json(response);
		}
		const outcome = await dispatcher.dispatch(endpoint, {
			type: "client-request",
			rpcId: request.rpcId,
			method: request.method,
			payload: request.payload,
		});
		if (outcome.status === 404) return new Response(null, { status: 404 });
		return Response.json(outcome.response);
	}

	/**
	 * The session-log download (`session-log-export` plugin): HEAD probes
	 * availability, GET serves the zip. Query: sessionId, includeDescendants.
	 */
	async function handleSessionExport(req: Request): Promise<Response> {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}
		const query = new URL(req.url).searchParams;
		const sessionId = query.get("sessionId");
		if (sessionId === null || sessionId === "") {
			return new Response(null, { status: 400 });
		}
		const archive = await options.driver.exportSessionLog(sessionId, query.get("includeDescendants") === "true");
		if (archive === undefined) {
			return new Response(null, { status: 404 });
		}
		const zip = buildZip(archive.entries);
		const headers = {
			"content-type": "application/zip",
			"content-disposition": `attachment; filename="omp-session-${sessionId}-logs.zip"`,
			"content-length": String(zip.length),
		};
		return new Response(req.method === "HEAD" ? null : zip, { status: 200, headers });
	}

	async function handlePluginBundle(req: Request, url: URL): Promise<Response> {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response(null, { status: 405 });
		}
		// Combo form (dsh 0.2.x): `/plugins/??<id>/client.js,<id>/client.js&rev=<rev>`
		// — the `??` list lives in the query string; members are concatenated
		// in list order. Source-map members (`<id>/client.js.map`) work the same.
		if (url.pathname === "/plugins/" && url.search.startsWith("??")) {
			const list = url.search.slice(2).split("&", 1)[0] ?? "";
			const members = list.split(",").filter(member => member !== "");
			if (members.length === 0) return new Response(null, { status: 404 });
			const parts: string[] = [];
			let allMaps = true;
			for (const member of members) {
				const isMap = member.endsWith("/client.js.map");
				if (!isMap && !member.endsWith("/client.js")) return new Response(null, { status: 404 });
				if (!isMap) allMaps = false;
				const id = member.slice(0, member.lastIndexOf("/client.js"));
				const clientPath = boot.table.get(id)?.clientPath;
				if (clientPath === undefined) return new Response(null, { status: 404 });
				const file = Bun.file(isMap ? `${clientPath}.map` : clientPath);
				if (!(await file.exists())) return new Response(null, { status: 404 });
				if (req.method === "GET") parts.push(await file.text());
			}
			return new Response(req.method === "HEAD" ? null : parts.join("\n"), {
				status: 200,
				headers: {
					"content-type": allMaps ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8",
					"cache-control": "no-cache",
				},
			});
		}
		const pathname = decodeURIComponent(url.pathname);
		const prefix = "/plugins/";
		const mapSuffix = "/client.js.map";
		const bundleSuffix = "/client.js";
		const isSourceMap = pathname.startsWith(prefix) && pathname.endsWith(mapSuffix);
		const suffix = isSourceMap ? mapSuffix : bundleSuffix;
		const id =
			pathname.startsWith(prefix) && pathname.endsWith(suffix)
				? pathname.slice(prefix.length, -suffix.length)
				: undefined;
		const clientPath = id !== undefined ? boot.table.get(id)?.clientPath : undefined;
		const target = clientPath !== undefined ? `${clientPath}${isSourceMap ? ".map" : ""}` : undefined;
		if (target === undefined) {
			// Registered but unreadable (bundle not built): a loud 404 beats a silent SPA-fallback HTML page.
			return new Response(null, { status: 404 });
		}
		const file = Bun.file(target);
		if (!(await file.exists())) {
			return new Response(null, { status: 404 });
		}
		return new Response(req.method === "HEAD" ? null : file, {
			status: 200,
			headers: {
				"content-type": isSourceMap ? "application/json; charset=utf-8" : "text/javascript; charset=utf-8",
				"cache-control": "no-cache",
			},
		});
	}
}
