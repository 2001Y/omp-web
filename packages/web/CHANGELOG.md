# Changelog

## [Unreleased]

### Changed (dsh 0.2.x port)

- Web mode now serves the DeepSeek Harness 0.2.x client stack (baseline 0.2.1-rc.2, tracked in `dsh-baseline.json`): the boot graph carries `batches` and combo plugin URLs, authentication is the launch-token → signed-cookie flow with a persisted secret, and the wire surface is the Typert Remote one (single bidirectional `/api/remote.mux`, two-member envelopes, `gateway/*` error codes) instead of the 0.1.x ApiProxy dialect.
- The boot roster is derived from the target tree's own bundle patches (`cordis.patch.yml` layers) instead of a hand-written list, and the `@omp/client-settings` overlay is ported to the 0.2.x client packages (the settings/history RPCs keep their names and shapes).

### Added (dsh 0.2.x port)

- `scripts/setup-dsh-web.sh` prepares a stock dsh tree for web mode without modifying it (the overlay directory is the only addition), with `OMP_WEB_DSH_BUILD=lib-web` for small machines.

### Fixed (omp-web M18)

- A parked approval/question ask no longer deadlocks abort: the driver stream carries `cancel-asks` before every turn-unwinding path (cancel / rewind / session switch), the server's `PendingInteractions.failSession` settles each parked gate promise, and the client panel drops via the `approval/resolved{rejected}` / `question/resolved{cancelled}` counterpart frames.
- `pageHistory` no longer soft-locks load-older on an empty page when the message budget cuts inside an over-budget turn (which also blanked the initial page for a giant latest turn); the window extends back to that turn's start instead.
- `skill.list` serves the real dsh shape (`{skills:[{name,description,modelInvocable}]}`, `skill:`-prefixed names) over `WebDriver.listSkills`, replacing the wrong-shaped empty stub.
- `workspace.list` rows carry the storage bucket's real mtime as `updatedAt` (and `createdAt` fallback) instead of a per-request stamp.
- `clientSettings/mutate` honors nested `path` arrays (prototype-pollution segments refused) and writes the store atomically (temp file + rename).
- `settings.mutate`-adjacent hardening: `fileReferences/list` refuses `..`/absolute path segments escaping the session cwd.
- `redactedThinking` blocks no longer render their provider-opaque blob as reasoning text.

### Added (omp-web M18)

- `GET/HEAD /api/session.export?sessionId=&includeDescendants=` serves the session-log zip for the `session-log-export` plugin (STORE-method writer in `src/server/zip.ts`; descendants follow the `parentSession` chain). `dsh-client-hmr` left the boot roster (the host does not serve its dev EventSource).
- The `session-attached` stream notification broadcasts the `session/subscribed` re-baseline (plus a non-empty queue snapshot) when the single attached window moves sessions.
- Dedicated settings RPCs `ompSettings/logoutProvider` and `ompSettings/setModelRole` replace the `__providerLogout:`/`__modelRole:` magic keys through `ompSettings/update` (driver verbs `logoutProvider`/`setModelRole`).
- `WebModelEntry.reasoning` is a declared protocol field (was an undeclared cast); `WebWorkspace.updatedAt` carries the bucket mtime.

### Changed (omp-web M18)

- The envelope `rpcId` is no longer threaded into `session.prompt` (the client treats `source.rpcId` as opaque; optimistic-echo reconciliation rides the queue snapshot messageId). `WebPromptOptions.rpcId` is removed.
- A late prompt rejection (after admission answered) surfaces in the transcript as a failed `prompt` command lifecycle instead of only the server log.

### Changed (omp-web M12/M13)

- `ompHistory/tree` now serves the TUI-parity full-entry tree (`WebHistoryNode`: kind/text/label/filter flags/currentLeaf, plus `branchSummariesEnabled`); `ompHistory/navigate` threads `summarize`/`customInstructions`; new `ompHistory/label` (entry labels, TUI Shift+L). `session.fork` announces the child via `session-added` and invalidates the list cache.

### Added

- New `@oh-my-pi/web` package (private): the web GUI host for the omp coding agent. Serves the vendored dsh-web browser stack (boot-graph-injected index.html, `/plugins/<id>/client.js` bundles), implements the `/api` browser RPC carrier (`host.describe`, `session.list`, `workspace.list`, `skill.list`; unimplemented methods fold into the wire `internal` error), the `/api/respond` receipt path, the two downlink-only WebSocket event streams, and the loopback Host/Origin trust fence — all over the injected `WebDriver` backend interface defined in `src/protocol/driver.ts`.
- M1 chat loop: the `session-event` vocabulary mirror (`src/protocol/events.ts`), driver methods for `session.create/history/prompt/cancel/rename/models`, storage-bucket-derived `workspace.list` (one `~/.omp/agent/sessions` cwd bucket per workspace), the mux `session/subscribed` baseline plus `session/event`/`session/projection` forwarding, and the host `session-added`/`session-status` downlinks. Contract tests cover the dispatcher, the downlink fan-out, and the boot graph (40 tests).
- M2 interactions: the answerable-ask registry (`approval/requested`/`question/requested` frames park until `/api/respond` settles them, replaying verbatim on mux reconnect with the ask id as the envelope rpcId so client responds map back), the resolved-frame broadcasts, and the `commands/list` + `commands/execute` typert remotes over `WebDriver.listCommands/executeCommand` (the wire `CommandExecution` shape: `{commandId, result}`).
- M3 batch 1: the `command/run`/`command/done` session-event vocabulary, the `session-queue` stream notification (broadcast as the `session/queue` mux snapshot and replayed right after the `session/subscribed` baseline), prompt delivery modes (`session.prompt` mode `queue|steer` → `WebDriver.prompt` options), and the `session.updateQueue` dispatch (`edit|remove|steer` over `WebDriver.updateQueue`).
- M3 batch 2: `settings.describe`/`settings.openDocument` over `WebDriver.settingsOverview`/`openSettingsDocument` (the document action renders through the client's own Settings document store), `subagent.list` shaping the catalog rows, and the `commands-changed` stream notification broadcast as the `commands/change` remote signal.
- M4 audit batch: the `plan/mode` session event and the `plan` projection stream notification (the `plan` projection key joins `title`), `settings.mutate`/`settings.update` folding onto `WebDriver.mutateClientSetting` (browser-client namespaces ride a permissive object schema in `settings.describe`), and the `agentPreset.list` empty stub.
- M7: the `session.fork` dispatch over `WebDriver.fork` (message-menu branching: an `atSeq`-anchored completed-turn cut materializes the child JSONL beside its source with inherited cwd/title and `parentSession` lineage, without disturbing the attached session).
- M5 batch 1: session-list titles ride the summary's projections block (`WebSessionSummary.title`), and the `fileReferences/list` typert remote dispatches onto `WebDriver.listFileReferences` (the `@`-mention candidate source).
- M5 batch 2: the OMP settings catalog wire shapes (`src/protocol/omp-settings.ts`), the `ompSettings/describe`/`ompSettings/update` dispatch (catalog over `WebDriver.ompSettingsCatalog`, writes over `setOmpSetting`), and the `@omp/client-settings` boot-roster entry serving the settings-section plugin from the vendored tree. Follow-ups per user direction: the section plugin is fully catalog-driven (no client-side tab hardcoding; tabs render in SETTING_TABS order with the schema's own labels), the settings nav scrolls through the panel's inherited `--dsw-scrollbar-*` styling, five dsh-native settings plugins with no omp counterpart left the roster (the general shell stays), and the form gained usability surfaces — per-field reset-to-default with modified markers (field- and group-level), field search on large tabs, collapsible groups (DisclosureRow), and a tab-level reset-all.
