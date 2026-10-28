/**
 * Run in web mode: serve the omp web GUI (the vendored dsh-web client stack)
 * over the Bun.serve host from `@oh-my-pi/web`, driven by an OMP-backed
 * {@link OmpWebDriver}, until the process is terminated.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { startWebServer, type WebServerHandle } from "@oh-my-pi/web";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import type { AgentSession } from "../../session/agent-session";
import { initializeExtensions } from "../runtime-init";
import { OmpWebDriver } from "./driver";
import { WebExtensionUIContext } from "./ui-context";

/** Default listen port (dsh serves 3080; omp takes a neighbor to coexist). */
const DEFAULT_WEB_PORT = 3180;

/**
 * Resolve the vendored dsh-web checkout serving the browser stack: the
 * `OMP_WEB_DSH_ROOT` override first, then an in-repo `dsh-web/` directory
 * (release-tarball layout), else the `dsh-web/` sibling of this repository
 * checkout (the omp-web workspace layout).
 */
function resolveDshRoot(): string {
	const override = process.env.OMP_WEB_DSH_ROOT;
	if (override !== undefined && override !== "") return path.resolve(override);
	const repoRoot = path.resolve(import.meta.dir, "../../../../../");
	return (
		[path.join(repoRoot, "dsh-web"), path.resolve(repoRoot, "..", "dsh-web")].find(candidate =>
			existsSync(path.join(candidate, "apps", "web", "dist", "index.html")),
		) ?? path.resolve(repoRoot, "..", "dsh-web")
	);
}

/**
 * Run in web mode.
 * @param session - the boot session (host snapshot anchor; the driver switches it as the UI moves).
 * @param setToolUIContext - the session's UI-context injector; the web mode
 * bridges tool approvals and extension dialogs onto the browser with it.
 */
export async function runWebMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
): Promise<never> {
	const preferredPort = Number.parseInt(process.env.OMP_WEB_PORT ?? "", 10) || DEFAULT_WEB_PORT;
	const noAuth = /^(?:1|true)$/i.test(process.env.OMP_WEB_NO_AUTH ?? "");
	const trustedHosts = (process.env.OMP_WEB_TRUSTED_HOSTS ?? "")
		.split(",")
		.map(host => host.trim())
		.filter(host => host !== "");
	const driver = new OmpWebDriver(session);
	const uiContext = new WebExtensionUIContext(driver);
	// Light up the tool context store (ask tool etc.) ...
	setToolUIContext?.(uiContext, true);
	// ... and the extension runner: the per-tool approval gate wraps every tool
	// in ExtensionToolWrapper, which consults the runner's UI context (not the
	// store) — without this pass, approvals fail closed with "no interactive UI".
	let shutdownRequested = false;
	await initializeExtensions(session, {
		mode: "rpc",
		reportSendError: (action, error) => {
			logger.warn(`omp-web: extension ${action} failed: ${error.message}`);
		},
		reportRuntimeError: error => {
			logger.warn(`omp-web: extension runtime error (${error.extensionPath}): ${error.error}`);
		},
		onShutdown: () => {
			shutdownRequested = true;
		},
		uiContext,
	});
	let server: WebServerHandle;
	try {
		server = await startWebServer({
			driver,
			dshRoot: resolveDshRoot(),
			port: preferredPort,
			noAuth,
			trustedHosts,
		});
	} catch (error) {
		// Occupied fixed port: fall back to an OS-assigned one instead of dying.
		const addrInUse = typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
		if (!addrInUse) throw error;
		logger.warn(`omp-web: port ${preferredPort} is in use; falling back to an OS-assigned port`);
		server = await startWebServer({
			driver,
			dshRoot: resolveDshRoot(),
			port: 0,
			noAuth,
			trustedHosts,
		});
	}
	if (noAuth) {
		logger.warn("omp-web: authentication disabled by OMP_WEB_NO_AUTH; relying on network-layer trust");
	}
	process.stdout.write(`omp web: ${server.accessUrl}\n`);
	// Park until SIGINT/SIGTERM or an extension-requested shutdown; signal
	// handlers resolve immediately, the poll covers the extension path.
	await new Promise<void>(resolve => {
		const request = (): void => {
			shutdownRequested = true;
			resolve();
		};
		process.once("SIGINT", request);
		process.once("SIGTERM", request);
		const poll = setInterval(() => {
			if (shutdownRequested) {
				clearInterval(poll);
				resolve();
			}
		}, 250);
	});
	await server.stop();
	process.exit(0);
}
