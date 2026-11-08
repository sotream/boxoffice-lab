#!/usr/bin/env bash
# A/B/A of inventory request signing on one machine: the commit before ADR 002 (inventory accepts unsigned requests, hold.js sends none),
# the commit with it (signed), and the unsigned commit again, so drift of the machine shows as the A to A2 difference.
#
# Usage: scripts/ab-signing.sh [runs=5]
# Needs: docker compose up -d, k6, pnpm, a clean checkout of this repository. Each side is a throwaway git worktree next to the repository
# (../boxoffice-lab-ab-A / -B), built there and removed on exit. Output: $AB_OUT (default ./ab-out, gitignored) with one table per side.
# Each side runs its OWN scripts/bench.sh and load script: `BENCH_CPU=1 scripts/bench.sh inventory <runs>`.
set -euo pipefail
RUNS=${1:-5}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
UNSIGNED=${AB_UNSIGNED:-b51732a}   # parent of 5875217 "inventory: authenticate internal routes with signed requests (ADR 002)"
SIGNED=${AB_SIGNED:-5875217}
OUT=${AB_OUT:-$ROOT/ab-out}; mkdir -p "$OUT"
log() { echo "$(date '+%F %T') $*" | tee -a "$OUT/ab.log"; }
git -C "$ROOT" cat-file -e "$UNSIGNED^{commit}" && git -C "$ROOT" cat-file -e "$SIGNED^{commit}" || { echo "commits $UNSIGNED / $SIGNED not found (git fetch?)" >&2; exit 1; }
[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || { echo "working tree is not clean" >&2; exit 1; }

cleanup() { for s in A B; do git -C "$ROOT" worktree remove --force "$ROOT/../boxoffice-lab-ab-$s" 2>/dev/null || true; done; }
trap cleanup EXIT
cleanup
git -C "$ROOT" worktree add --detach "$ROOT/../boxoffice-lab-ab-A" "$UNSIGNED" >/dev/null
git -C "$ROOT" worktree add --detach "$ROOT/../boxoffice-lab-ab-B" "$SIGNED" >/dev/null
for s in A B; do ( cd "$ROOT/../boxoffice-lab-ab-$s" && log "build $s ($(git rev-parse --short HEAD))" && pnpm install --frozen-lockfile >/dev/null && pnpm build >/dev/null ); done

for step in "A:A:unsigned" "B:B:signed" "A2:A:unsigned again"; do
  name=${step%%:*}; rest=${step#*:}; tree=${rest%%:*}; label=${rest#*:}
  pmset -g batt 2>/dev/null | head -1 | grep -q "AC Power" || log "WARNING: not on AC power before $name"
  log "running $name ($label) load=$(uptime | sed 's/.*load averages*: //')"
  ( cd "$ROOT/../boxoffice-lab-ab-$tree" && BENCH_CPU=1 BENCH_OUT="$OUT/raw-$name" scripts/bench.sh inventory "$RUNS" >"$OUT/$name.out" 2>&1 ) || log "$name FAILED, see $OUT/$name.out"
  cp "$OUT/raw-$name/table.md" "$OUT/$name.table.md" 2>/dev/null || true
done
log "done: compare $OUT/A.table.md, B.table.md, A2.table.md (A and A2 are the same code; their difference is the noise)"
