# @oh-my-pi/web

The web GUI host for the omp coding agent. This package is pure glue per the
omp-web fork rules: every visual byte comes from the vendored dsh-web client
stack (`@deepseek-ai/*` packages vendored at `dsh-web/` in the omp-web
workspace root — see that workspace's `PROVENANCE.md`), and every backend
capability arrives through the `WebDriver` interface implemented by the
coding agent's web mode (`packages/coding-agent/src/modes/web/`).

## What it serves

- `GET /` — the built `apps/web` dist with the boot protocol injected: the
  `window.__ModuleLoader__` queue facade, parser preloads for the
  `dsh-client-modules`/`dsh-client-runtime` bundles, and the
  `window.__DSH_BOOT__` entry graph composed from the vendored packages.
- `GET /plugins/<id>/client.js[.map]` — the browser plugin bundles.
- `POST /api/<method>` — the four-quadrant RPC carrier. `host.describe`,
  `session.list`, `workspace.list`, and `skill.list` are bridged onto the
  driver; every other method (including generated Remote endpoints) answers
  the wire `internal` error until a later milestone implements it.
- `POST /api/respond` — the approval/question response carrier (no pending
  server-requests yet, so it answers the `not-pending` receipt).
- `GET /api/events.mux`, `GET /api/events.host` — downlink-only WebSocket
  event streams.

Every `/api` request and upgrade passes the loopback Host + same-origin
Origin fence (DNS-rebinding and cross-site defense, mirroring the dsh client
connection plugin). The server binds `127.0.0.1` by default.

## Dependency direction

`coding-agent → @oh-my-pi/web`. The reverse direction exists only as the
`WebDriver` interface injection (`src/protocol/driver.ts`); this package never
imports the coding agent.
