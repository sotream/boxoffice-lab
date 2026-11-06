#!/usr/bin/env bash
# Needs: docker compose up -d postgres redis; pnpm build; k6
set -euo pipefail
cd "$(dirname "$0")/.."
run() { # name strategy cache rare
  echo "=== $1 ==="
  docker exec boxoffice-lab-redis-1 redis-cli flushall >/dev/null
  STRATEGY=$2 CACHE=$3 RARE=$4 k6 run --quiet --summary-export=/tmp/cat.json load/search.js >/dev/null 2>&1
  node -e "const m=require('/tmp/cat.json').metrics;const d=m.http_req_duration;console.log(JSON.stringify({rps:+m.http_reqs.rate.toFixed(0),p50:+d.med.toFixed(1),p95:+d['p(95)'].toFixed(1),p99:+d['p(99)'].toFixed(1)}))"
}
SEED_EVENTS=${SEED_EVENTS:-200000} node dist/main.js & PID=$!
sleep 8
run "common terms: ilike (date order)" ilike 0 0
run "common terms: fts-date (GIN, date order)" fts-date 0 0
run "common terms: fts ranked (GIN + ts_rank)" fts 0 0
run "common terms: fts ranked + Redis cache" fts 1 0
run "rare term: ilike" ilike 0 1
run "rare term: fts-date" fts-date 0 1
kill $PID; wait $PID 2>/dev/null || true
