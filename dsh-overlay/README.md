# dsh-overlay — omp-web fork's dsh-side plugin sources

The web mode serves the **DeepSeek Harness** web client stack
([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness),
MIT, pinned baseline `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`). That tree is
**not** vendored into this repository — it is either source-built by
`scripts/setup-dsh-web.sh` or unpacked from the `dsh-web-runtime` release
tarball.

This directory carries the one piece of fork code that lives *inside* the dsh
tree's plugin layout:

- `packages/client/omp-settings/` — the `@omp/client-settings` roster plugin
  (OMP settings sections + History view), authored against the dsh client
  plugin contract. It is copied into `packages/client/` of a built dsh tree by
  the setup script; the release tarball ships its built `lib/client.js`
  alongside the 40 dsh-native bundles.

Vendored dsh files themselves carry **zero modifications** — every adaptation
is either this overlay or host-side glue in `packages/web`. The full component
provenance ledger is `docs/web/PROVENANCE.md`.
