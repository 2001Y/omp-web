#!/usr/bin/env bash
# Report upstream drift for the two tracks this fork follows:
#   - dsh: the npm `latest` dist-tag vs dsh-baseline.json
#   - omp: the latest can1357/oh-my-pi release vs the branch's upstream base
# Read-only. Exit 0 when nothing moved, 3 when drift was found, 1 on error.
# Used by .github/workflows/follow-upstream.yml and runnable locally.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="$REPO_ROOT/dsh-baseline.json"
drift=0

baseline_version="$(bun -e 'const b = await Bun.file(process.argv[1]).json(); console.log(b.version)' "$BASELINE")"
baseline_commit="$(bun -e 'const b = await Bun.file(process.argv[1]).json(); console.log(b.commit)' "$BASELINE")"
npm_tag="$(bun -e 'const b = await Bun.file(process.argv[1]).json(); console.log(b.npmTag)' "$BASELINE")"

echo "== dsh track (npm dist-tag: $npm_tag)"
echo "   baseline: $baseline_version ($baseline_commit)"
dsh_latest="$(npm view @deepseek-ai/dsh dist-tags --json | bun -e 'const tags = await Bun.stdin.json(); console.log(tags[process.argv[1]] ?? "")' "$npm_tag")"
echo "   latest:   $dsh_latest"
if [ "$dsh_latest" != "$baseline_version" ]; then
  echo "   DRIFT: dsh $baseline_version -> $dsh_latest"
  drift=3
fi

echo "== omp track (can1357/oh-my-pi releases)"
base_ref="$(git -C "$REPO_ROOT" merge-base HEAD upstream/main 2>/dev/null || echo "")"
if [ -n "$base_ref" ]; then
  echo "   branch base: $base_ref"
else
  echo "   branch base: unknown (no upstream remote/fetch in this checkout)"
fi
omp_latest="$(gh api repos/can1357/oh-my-pi/releases/latest --jq .tag_name 2>/dev/null || echo "")"
echo "   latest release: ${omp_latest:-unknown}"
if [ -n "$base_ref" ] && [ -n "$omp_latest" ]; then
  base_tag="$(git -C "$REPO_ROOT" describe --tags --exact-match "$base_ref" 2>/dev/null || echo "")"
  echo "   branch base tag: ${base_tag:-none}"
  if [ -n "$base_tag" ] && [ "$base_tag" != "$omp_latest" ] && [ "v$base_tag" != "$omp_latest" ]; then
    echo "   DRIFT: omp base $base_tag -> $omp_latest"
    drift=3
  fi
fi

if [ "$drift" = "3" ]; then
  echo "result: drift detected"
else
  echo "result: up to date"
fi
exit "$drift"
