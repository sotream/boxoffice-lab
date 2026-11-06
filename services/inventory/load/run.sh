#!/usr/bin/env bash
# Usage: load/run.sh  (needs: docker compose up -d postgres, pnpm build, k6)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=3101
for strategy in atomic-update for-update; do
  for range in 100000 20; do
    SEED_SEATS=100000 PORT=$PORT PG_POOL=20 node dist/main.js &
    PID=$!
    sleep 2
    echo "=== strategy=$strategy range=$range ==="
    STRATEGY=$strategy RANGE=$range k6 run --quiet --summary-export=/tmp/k6-$strategy-$range.json load/hold.js >/dev/null
    node -e "const s=require('/tmp/k6-$strategy-$range.json').metrics;const d=s.http_req_duration;console.log(JSON.stringify({rps:+s.http_reqs.rate.toFixed(0),p50:+d.med.toFixed(1),p95:+d['p(95)'].toFixed(1),p99:+(d['p(99)']??0).toFixed(1),ok:s.holds_ok?.count??0,conflict:s.holds_conflict?.count??0}))"
    kill $PID; wait $PID 2>/dev/null || true
  done
done
