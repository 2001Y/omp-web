#!/usr/bin/env bash
# Source-build the dsh-web browser runtime for omp-web.
#
# Clones deepseek-ai/deepseek-harness at the pinned baseline, overlays the
# fork's @omp/client-settings plugin (dsh-overlay/), and builds the Vite shell
# plus every roster plugin bundle. The result is a runtime tree usable as the
# web mode's dsh root: place it at <repo>/dsh-web (auto-detected), next to the
# repo as a sibling, or point OMP_WEB_DSH_ROOT at it.
#
# Usage: scripts/setup-dsh-web.sh [target-dir]   (default: <repo>/dsh-web)
#
# Requires: git, pnpm 11.7+, node ^22.19 || >=24 (deepseek-harness engines).
set -euo pipefail

DSH_REPO="https://github.com/deepseek-ai/deepseek-harness.git"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The baseline's single source of truth is <repo>/dsh-baseline.json; bump only there.
DSH_COMMIT="$(bun -e 'const b = await Bun.file(process.argv[1]).json(); process.stdout.write(b.commit)' "$REPO_ROOT/dsh-baseline.json")"
[ -n "$DSH_COMMIT" ] || { echo "error: could not read commit from dsh-baseline.json" >&2; exit 1; }
TARGET="$(cd "${1:-$REPO_ROOT/dsh-web}" 2>/dev/null && pwd || echo "${1:-$REPO_ROOT/dsh-web}")"
PLUGIN_REL="packages/client/omp-settings"

echo "==> dsh-web source build"
echo "    repo:     $DSH_REPO"
echo "    baseline: $DSH_COMMIT"
echo "    target:   $TARGET"

if [ -d "$TARGET/.git" ]; then
  echo "==> reusing existing clone"
  git -C "$TARGET" fetch --quiet origin "$DSH_COMMIT" || true
else
  echo "==> cloning (treeless, single pinned commit)"
  mkdir -p "$TARGET"
  git -C "$TARGET" init -q
  git -C "$TARGET" remote add origin "$DSH_REPO"
  git -C "$TARGET" fetch -q --depth 1 origin "$DSH_COMMIT"
fi
git -C "$TARGET" checkout -q --detach "$DSH_COMMIT"
# A pristine baseline is required: the overlay must apply onto unmodified files.
if [ -n "$(git -C "$TARGET" status --porcelain --untracked-files=no)" ]; then
  echo "error: $TARGET has local modifications; reset or pick another target" >&2
  exit 1
fi

echo "==> pnpm install (frozen lockfile)"
pnpm --dir "$TARGET" install --frozen-lockfile

echo "==> pnpm build (build:lib + build:web)"
pnpm --dir "$TARGET" build

echo "==> overlaying @omp/client-settings"
rm -rf "$TARGET/$PLUGIN_REL"
mkdir -p "$(dirname "$TARGET/$PLUGIN_REL")"
cp -r "$REPO_ROOT/dsh-overlay/$PLUGIN_REL" "$TARGET/$PLUGIN_REL"

# The overlay package is not part of the pnpm lockfile; link its workspace
# peer dependencies by hand (mirrors the vendored tree's layout).
link_pkg() { # $1 = package name
  local manifest dir
  for manifest in "$TARGET"/vendor/*/package.json "$TARGET"/packages/*/*/package.json; do
    [ -f "$manifest" ] || continue
    if grep -q "\"name\": \"$1\"" "$manifest"; then
      dir="$(dirname "$manifest")"
      mkdir -p "$TARGET/$PLUGIN_REL/node_modules/$(dirname "$1")"
      ln -sfn "$(realpath --relative-to="$TARGET/$PLUGIN_REL/node_modules/$(dirname "$1")" "$dir")" \
        "$TARGET/$PLUGIN_REL/node_modules/$1"
      return 0
    fi
  done
  echo "error: workspace package $1 not found under $TARGET" >&2
  return 1
}

echo "==> linking overlay workspace dependencies"
# Derived from the overlay's own peerDependencies (react keeps its .pnpm
# special case below); new overlay dependencies follow automatically.
while IFS= read -r dep; do
  [ -n "$dep" ] && link_pkg "$dep"
done < <(bun -e 'const p = await Bun.file(process.argv[1]).json(); for (const name of Object.keys(p.peerDependencies ?? {})) { if (name !== "react") console.log(name) }' "$REPO_ROOT/dsh-overlay/$PLUGIN_REL/package.json")
react_dir="$(ls -d "$TARGET"/node_modules/.pnpm/react@*/node_modules/react 2>/dev/null | head -1)"
[ -n "$react_dir" ] || { echo "error: react not found in $TARGET/node_modules/.pnpm" >&2; exit 1; }
ln -sfn "$(realpath --relative-to="$TARGET/$PLUGIN_REL/node_modules" "$react_dir")" \
  "$TARGET/$PLUGIN_REL/node_modules/react"
types_react="$(ls -d "$TARGET"/node_modules/.pnpm/@types+react@*/node_modules/@types/react 2>/dev/null | head -1)"
if [ -n "$types_react" ]; then
  mkdir -p "$TARGET/$PLUGIN_REL/node_modules/@types"
  ln -sfn "$(realpath --relative-to="$TARGET/$PLUGIN_REL/node_modules/@types" "$types_react")" \
    "$TARGET/$PLUGIN_REL/node_modules/@types/react"
fi

echo "==> bundling @omp/client-settings"
TSDOWN="$TARGET/node_modules/.bin/tsdown"
[ -x "$TSDOWN" ] || { echo "error: tsdown not found at $TSDOWN" >&2; exit 1; }
(cd "$TARGET/$PLUGIN_REL" && "$TSDOWN")

echo "==> verifying runtime tree"
[ -f "$TARGET/apps/web/dist/index.html" ] || { echo "error: apps/web/dist/index.html missing" >&2; exit 1; }
bundles="$(find "$TARGET"/packages/*/*/lib -maxdepth 1 -name client.js 2>/dev/null | wc -l)"
echo "    found $bundles plugin bundles (sanity floor: 30; the boot roster itself is derived from the tree's bundle patches at runtime)"
[ "$bundles" -ge 30 ] || { echo "error: incomplete build" >&2; exit 1; }
[ -f "$TARGET/packages/client/modules/lib/client.js" ] || { echo "error: bootstrap bundle (client-modules) missing" >&2; exit 1; }

echo "==> done"
if [ "$TARGET" = "$REPO_ROOT/dsh-web" ]; then
  echo "    web mode auto-detects $TARGET — run: bun packages/coding-agent/src/cli.ts --mode web"
else
  echo "    run with: OMP_WEB_DSH_ROOT=\"$TARGET\" bun packages/coding-agent/src/cli.ts --mode web"
fi
