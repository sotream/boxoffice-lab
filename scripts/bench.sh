#!/usr/bin/env bash
# Repeatable load measurements: starts the built services itself, runs the existing k6 scripts N times and
# prints a Markdown table of median, min and max per scenario row.
#
# Usage: scripts/bench.sh <scenario> [runs=3]
#   scenario: inventory | waiting-room | payments | catalog | gateway | notifications | all
# Needs: docker compose up -d (Postgres, Redis; Redpanda for payments and notifications), pnpm build, k6 (not for notifications), node, curl.
# Env:
#   BENCH_OUT        output directory for raw k6 summaries and table.md (default ./bench-out, gitignored)
#   BENCH_REDIS_DB   Redis logical database used by waiting-room, catalog and gateway (default 12); flushed before each run
#   REDIS_CONTAINER, PG_CONTAINER  containers used to flush Redis and truncate payments tables. Default: the
#                    container publishing port 56379 / 55432 (works for compose and for CI service containers).
#   DATABASE_URL     used with psql for the payments cleanup if psql exists (default postgres://lab:lab@localhost:55432/lab)
#   BENCH_MAX_LOAD   1-minute load average above which a run waits (default 4, up to BENCH_LOAD_WAIT=60 s), then proceeds
#   VUS, DURATION    passed through to k6 unchanged (the scripts' own defaults apply when unset)
#   BENCH_CPU        1 = sample per-process CPU during each k6 run (default off): node, k6, postgres, redis-server and
#                    the VM/container layer (macOS com.apple.Virtualization.VirtualMachine, Linux dockerd, containerd-shim),
#                    from `ps -Ao pcpu,comm`. Raw samples go to cpu-<label>.log, a peak/mean table to the output and table.md.
#   BENCH_CPU_INTERVAL  seconds between CPU samples (default 5)
#   INVENTORY_INTERNAL_TOKEN, PAYMENTS_INTERNAL_TOKEN  request-signing keys; inherited by the started services and by k6 (hold.js and pay.js sign),
#                    so unset (the development defaults on both sides) works and a custom value only has to be exported once
#   N, SENDER_LATENCY_MS, CONCURRENCY  passed through to services/notifications/load/bench.js (its defaults: 20000 events, 20 ms, 25)
# gateway: rows "direct to inventory" (BASE=inventory :3101) and "through gateway" (BASE=gateway :3100) of load/overhead.js, GET
#   availability only, so waiting-room is not started. The gateway runs with IP_RATE=100000 IP_BURST=100000 (as the e2e Stack does): the
#   per-IP limiter is effectively off, so it does not cap the measurement (a 429 would show up as a failed request in the table). The limiter
#   itself is still in the path (one Redis round trip per request), only its limit is out of reach. Both sides use the same signing key
#   (INVENTORY_INTERNAL_TOKEN): overhead.js signs the direct request, the gateway signs its own forwarded request. The gateway's /readyz is on
#   its ops port (3106), which is where the readiness wait looks.
# notifications: load/bench.js is a single node process (producer, consumer and checks in one), not a k6 script and not a started service:
#   it creates a fresh 3-partition topic, produces 21 010 events (1 000 duplicates, 10 poison), consumes them with PARTS=1 and PARTS=3
#   partitions at once, and prints one JSON line with the integrity checks. Rows: one per PARTS value; the table shows time, deliveries/s,
#   sent vs expected, duplicate rows, dead letters (10 expected) and provider calls. bench.js empties notifications.deliveries before each run
#   and deletes its topics when it ends; bench.sh truncates the table again and removes leftover bench topics/groups on exit, so nothing of a
#   run is left in Postgres or Redpanda. Needs Postgres and Redpanda (59092); nothing else listens, so ports are not an issue.
# Nothing in the k6 scripts is changed; services are started from dist/ and are always killed on exit.
set -euo pipefail

SCENARIO=${1:-}
RUNS=${2:-3}
case "$SCENARIO" in inventory | waiting-room | payments | catalog | gateway | notifications | all) ;; *)
  echo "usage: $0 <inventory|waiting-room|payments|catalog|gateway|notifications|all> [runs=3]" >&2; exit 2 ;; esac
[[ "$RUNS" =~ ^[1-9][0-9]*$ ]] || { echo "runs must be a positive integer" >&2; exit 2; }

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${BENCH_OUT:-$ROOT/bench-out}
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d)
REDIS_DB=${BENCH_REDIS_DB:-12}
DATABASE_URL=${DATABASE_URL:-postgres://lab:lab@localhost:55432/lab}
PIDS=()
CPU_PID=
NOTIF_DIRTY=0
cleanup() {
  local p
  [ -n "$CPU_PID" ] && kill "$CPU_PID" 2>/dev/null || true
  [ -n "$CPU_PID" ] && wait "$CPU_PID" 2>/dev/null || true
  for p in ${PIDS[@]+"${PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done
  for p in ${PIDS[@]+"${PIDS[@]}"}; do wait "$p" 2>/dev/null || true; done
  if [ "$NOTIF_DIRTY" = 1 ]; then notifications_cleanup || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

[ "$SCENARIO" = notifications ] || command -v k6 >/dev/null || { echo "k6 not found" >&2; exit 1; }
: >"$OUT/table.md"

# --- helpers -----------------------------------------------------------------------------------------------------

container_for_port() { docker ps --filter "publish=$1" --format '{{.Names}}' 2>/dev/null | head -n1 || true; }

# start_service <package> <port> [VAR=value ...]: sets SVC_PID. Refuses to run when the port is already served.
# PROBE_PORT=<port> start_service ...: poll /readyz there instead (the gateway serves it only on its ops port).
start_service() {
  local pkg=$1 port=$2; shift 2
  if curl -s -o /dev/null "localhost:$port/healthz"; then
    echo "port $port is already in use (another service or run): stop it first" >&2; exit 1
  fi
  ( cd "$ROOT/services/$pkg" && exec env PORT="$port" "$@" node dist/main.js ) >"$WORK/$pkg.log" 2>&1 &
  SVC_PID=$!
  PIDS+=("$SVC_PID")
  # Seeding and migrating take a few seconds: wait for readiness instead of a fixed sleep.
  local i
  for i in $(seq 1 240); do
    curl -sf "localhost:${PROBE_PORT:-$port}/readyz" >/dev/null 2>&1 && return 0
    kill -0 "$SVC_PID" 2>/dev/null || { echo "$pkg exited during start:" >&2; tail -n 20 "$WORK/$pkg.log" >&2; exit 1; }
    sleep 0.5
  done
  echo "$pkg did not become ready" >&2; tail -n 20 "$WORK/$pkg.log" >&2; exit 1
}

stop_service() { kill "$1" 2>/dev/null || true; wait "$1" 2>/dev/null || true; }

FLUSH_WARNED=0
flush_redis_db() {
  local c=${REDIS_CONTAINER:-$(container_for_port 56379)}
  if [ -n "$c" ] && docker exec "$c" redis-cli -n "$REDIS_DB" flushdb >/dev/null 2>&1; then return 0; fi
  if [ "$FLUSH_WARNED" = 0 ]; then
    echo "note: no Redis container found (set REDIS_CONTAINER): Redis db $REDIS_DB is NOT flushed; repeated runs may see old keys" >&2
    FLUSH_WARNED=1
  fi
}

truncate_payments() {
  # The schema is created by the payments service on its first start, so on a fresh database it does not exist yet.
  local sql="DO \$\$ BEGIN IF to_regclass('payments.payments') IS NOT NULL THEN TRUNCATE payments.payments, payments.outbox; END IF; END \$\$"
  if command -v psql >/dev/null; then psql -q "$DATABASE_URL" -c "$sql" >/dev/null; return; fi
  local c=${PG_CONTAINER:-$(container_for_port 55432)}
  [ -n "$c" ] || { echo "payments cleanup needs psql or a Postgres container (PG_CONTAINER)" >&2; exit 1; }
  docker exec "$c" psql -q -U lab -d lab -c "$sql" >/dev/null
}

# cpu_start <outfile-prefix>: with BENCH_CPU=1, samples %CPU (per core: 190 = ~1.9 cores) of the named processes every
# BENCH_CPU_INTERVAL s into $OUT/cpu-<label>.log as "run sample name sum" (sum over same-named processes); sets CPU_PID.
CPU_NAMES="node k6 postgres redis-server com.apple.Virtualization.VirtualMachine dockerd containerd-shim"
cpu_start() {
  [ "${BENCH_CPU:-0}" = 1 ] || return 0
  local base=${1##*/} run log
  run=${base##*.run}; log="$OUT/cpu-${base%.run*}.log"
  [ "$run" = 1 ] && : >"$log"
  (
    trap 'kill $(jobs -p) 2>/dev/null; exit 0' TERM
    n=0
    while :; do
      ps -Ao pcpu,comm 2>/dev/null | awk -v names="$CPU_NAMES" -v run="$run" -v n="$n" '
        BEGIN { split(names, a, " "); for (i in a) want[a[i]] = 1 }
        NR > 1 { c = $1; sub(/^ *[0-9.,]+ +/, ""); sub(/.*\//, ""); if ($0 in want) sum[$0] += c }
        END { for (k in sum) print run, n, k, sum[k] }' >>"$log" || true
      n=$((n + 1))
      sleep "${BENCH_CPU_INTERVAL:-5}" &
      wait $! || true
    done
  ) &
  CPU_PID=$!
}
cpu_stop() {
  [ -n "$CPU_PID" ] || return 0
  kill "$CPU_PID" 2>/dev/null || true
  wait "$CPU_PID" 2>/dev/null || true
  CPU_PID=
}
# cpu_emit <label>: peak and mean of the per-sample sums per process name (a sample without the process counts as 0).
cpu_emit() {
  [ "${BENCH_CPU:-0}" = 1 ] || return 0
  local log="$OUT/cpu-$1.log"
  [ -s "$log" ] || return 0
  emit ""
  emit "CPU of $1 (%CPU per core: 100 = 1 core; sampled every ${BENCH_CPU_INTERVAL:-5} s)"
  emit ""
  emit "| Process | Peak % | Mean % | Samples |
|---|---|---|---|"
  emit "$(awk '
    { s = $1 SUBSEP $2; seen[s] = 1; v[$3, s] = $4; names[$3] = 1 }
    END {
      for (s in seen) total++
      for (k in names) {
        peak = 0; sum = 0
        for (s in seen) { x = ((k, s) in v) ? v[k, s] : 0; sum += x; if (x > peak) peak = x }
        printf "| %s | %.0f | %.0f | %d |\n", k, peak, sum / total, total
      }
    }' "$log" | sort)"
}

# k6_run <outfile-prefix> <script>: summary in <prefix>.json, k6 exit code in <prefix>.rc (99 = a threshold failed).
k6_run() {
  local rc=0
  cpu_start "$1"
  k6 run --quiet --summary-export="$1.json" "$2" >"$1.out" 2>&1 || rc=$?
  cpu_stop
  echo "$rc" >"$1.rc"
  if [ ! -s "$1.json" ]; then echo "k6 produced no summary (exit $rc):" >&2; tail -n 20 "$1.out" >&2; exit 1; fi
}

# row <label> <prefix>: Markdown table row from <prefix>.run*.json
row() {
  local label=$1 prefix=$2
  node - "$label" "$prefix" <<'JS'
const fs = require("fs");
const [label, prefix] = process.argv.slice(2);
const dir = require("path").dirname(prefix), base = require("path").basename(prefix);
const files = fs.readdirSync(dir).filter((f) => f.startsWith(base + ".run") && f.endsWith(".json")).sort();
const runs = files.map((f) => ({ m: JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")).metrics, rc: Number(fs.readFileSync(`${dir}/${f.replace(/\.json$/, ".rc")}`, "utf8")) }));
const stat = (xs, d) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return `${med.toFixed(d)} (${s[0].toFixed(d)}-${s[n - 1].toFixed(d)})`;
};
const rps = runs.map((r) => r.m.http_reqs.rate);
const p95 = runs.map((r) => r.m.http_req_duration["p(95)"]);
const p99 = runs.map((r) => r.m.http_req_duration["p(99)"]);
const failedReq = runs.reduce((a, r) => a + (r.m.http_req_failed?.passes ?? 0), 0);
const failedChk = runs.reduce((a, r) => a + (r.m.checks?.fails ?? 0), 0);
const thr = runs.filter((r) => r.rc === 99).length;
const other = runs.filter((r) => r.rc !== 0 && r.rc !== 99).length;
console.log(`| ${label} | ${runs.length} | ${stat(rps, 0)} | ${stat(p95, 1)} | ${stat(p99, 1)} | ${failedReq} | ${failedChk} | ${thr}/${runs.length}${other ? ` (+${other} k6 errors)` : ""} |`);
JS
}

HEADER="| Row | Runs | RPS median (min-max) | p95 ms median (min-max) | p99 ms median (min-max) | Failed requests (sum) | Failed checks (sum) | Runs with a threshold breached |
|---|---|---|---|---|---|---|---|"

# table_begin <scenario title> [header]; table_row appends to stdout and table.md
emit() { printf '%s\n' "$1" | tee -a "$OUT/table.md"; }
table_begin() {
  emit ""
  emit "### $1 ($RUNS runs, $(date -u +%Y-%m-%d), commit $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown))"
  emit ""
  emit "${2:-$HEADER}"
}
# check_load <label>: logs the 1-minute load average; above BENCH_MAX_LOAD (default 4) it waits up to
# BENCH_LOAD_WAIT seconds (default 60) for it to fall (a previous run's own load decays too), then goes on and says so.
load1() { uptime | sed 's/.*load averages*: *//' | awk '{gsub(",", ".", $1); print $1}'; }
check_load() {
  local max=${BENCH_MAX_LOAD:-4} waited=0 l note=""
  l=$(load1)
  while awk "BEGIN{exit !($l > $max)}" && [ "$waited" -lt "${BENCH_LOAD_WAIT:-60}" ]; do
    sleep 10; waited=$((waited + 10)); l=$(load1)
  done
  if awk "BEGIN{exit !($l > $max)}"; then note=" (above $max, run goes ahead anyway)"; fi
  [ "$waited" -gt 0 ] && note="$note (waited ${waited}s)"
  echo "load average (1 min) before $1: $l$note" >&2
  printf 'load average (1 min) before %s: %s%s\n' "$1" "$l" "$note" >>"$OUT/load.log"
}

# --- scenarios ---------------------------------------------------------------------------------------------------

bench_inventory() {
  table_begin "inventory (load/hold.js, script defaults 50 VUs, 20 s, 100 000 seats)"
  local strategy range r prefix
  for strategy in atomic-update for-update; do
    for range in 100000 20; do
      prefix="$OUT/inventory-$strategy-$range"; rm -f "$prefix".run*
      for r in $(seq 1 "$RUNS"); do
        # A fresh service and a re-seeded table per run: holds from the previous run must not leak into this one.
        start_service inventory 3101 SEED_SEATS=100000 PG_POOL=20
        check_load "inventory $strategy range=$range run $r"
        echo "inventory $strategy range=$range run $r/$RUNS" >&2
        STRATEGY=$strategy RANGE=$range k6_run "$prefix.run$r" "$ROOT/services/inventory/load/hold.js"
        stop_service "$SVC_PID"
      done
      emit "$(row "$strategy, $([ "$range" = 20 ] && echo 'hot (20 seats)' || echo 'low contention (100 000 seats)')" "$prefix")"
      cpu_emit "inventory-$strategy-$range"
    done
  done
}

bench_waiting_room() {
  table_begin "waiting-room (load/join.js, script defaults 100 VUs, 20 s)"
  local prefix="$OUT/waiting-room" r; rm -f "$prefix".run*
  for r in $(seq 1 "$RUNS"); do
    # User ids repeat between runs, so each run starts with an empty Redis database.
    flush_redis_db
    start_service waiting-room 3102 REDIS_URL="redis://localhost:56379/$REDIS_DB"
    check_load "waiting-room run $r"
    echo "waiting-room run $r/$RUNS" >&2
    k6_run "$prefix.run$r" "$ROOT/services/waiting-room/load/join.js"
    stop_service "$SVC_PID"
  done
  emit "$(row "join + 2 status polls" "$prefix")"
  cpu_emit waiting-room
}

bench_payments() {
  table_begin "payments (load/pay.js, script defaults 100 VUs, 20 s, compensation path; needs Redpanda)"
  local lat r prefix inv
  # Inventory is needed for the seat confirm that fails (seats are not held), as in services/payments/RESULTS.md.
  start_service inventory 3101 SEED_SEATS=100000 PG_POOL=20
  inv=$SVC_PID
  for lat in 100 0; do
    prefix="$OUT/payments-psp$lat"; rm -f "$prefix".run*
    for r in $(seq 1 "$RUNS"); do
      # Idempotency keys repeat between runs: an unclean table would turn the run into cached replays.
      truncate_payments
      start_service payments 3103 PSP_LATENCY_MS="$lat" PG_POOL=20 VERIFY_HOLDS=0 # pay.js pays for seats nobody holds: with the pre-charge check (ADR 007) it would measure the cheap FAILED path, not the compensation path
      check_load "payments psp=${lat}ms run $r"
      echo "payments psp=${lat}ms run $r/$RUNS" >&2
      k6_run "$prefix.run$r" "$ROOT/services/payments/load/pay.js"
      stop_service "$SVC_PID"
    done
    emit "$(row "PSP latency $lat ms" "$prefix")"
    cpu_emit "payments-psp$lat"
  done
  stop_service "$inv" # port 3101 is needed again by the gateway scenario in `all`
}

bench_catalog() {
  table_begin "catalog (load/search.js, script defaults 50 VUs, 15 s, 200 000 events)"
  start_service catalog 3104 SEED_EVENTS="${SEED_EVENTS:-200000}" REDIS_URL="redis://localhost:56379/$REDIS_DB"
  local spec name strategy cache rare r prefix i=0
  for spec in "common terms: ilike (date order)|ilike|0|0" "common terms: fts-date (GIN, date order)|fts-date|0|0" \
              "common terms: fts ranked (GIN + ts_rank)|fts|0|0" "common terms: fts ranked + Redis cache|fts|1|0" \
              "rare term: ilike|ilike|0|1" "rare term: fts-date|fts-date|0|1"; do
    IFS='|' read -r name strategy cache rare <<<"$spec"
    i=$((i + 1)); prefix="$OUT/catalog-$i"; rm -f "$prefix".run*
    for r in $(seq 1 "$RUNS"); do
      flush_redis_db
      check_load "catalog '$name' run $r"
      echo "catalog '$name' run $r/$RUNS" >&2
      STRATEGY=$strategy CACHE=$cache RARE=$rare k6_run "$prefix.run$r" "$ROOT/services/catalog/load/search.js"
    done
    emit "$(row "$name" "$prefix")"
    cpu_emit "catalog-$i"
  done
  stop_service "$SVC_PID"
}

bench_gateway() {
  table_begin "gateway (load/overhead.js, script defaults 50 VUs, 15 s, GET availability; IP limiter effectively off)"
  local r prefix inv
  start_service inventory 3101 SEED_SEATS=100000 PG_POOL=20
  inv=$SVC_PID
  prefix="$OUT/gateway-direct"; rm -f "$prefix".run*
  for r in $(seq 1 "$RUNS"); do
    check_load "gateway direct run $r"
    echo "gateway direct to inventory run $r/$RUNS" >&2
    BASE=http://localhost:3101 k6_run "$prefix.run$r" "$ROOT/services/gateway/load/overhead.js"
  done
  emit "$(row "direct to inventory" "$prefix")"
  cpu_emit gateway-direct
  # Waiting-room and payments are not started: the gateway only builds their URLs, and GET availability does not touch them.
  flush_redis_db
  PROBE_PORT=3106 start_service gateway 3100 OPS_PORT=3106 REDIS_URL="redis://localhost:56379/$REDIS_DB" IP_RATE=100000 IP_BURST=100000
  prefix="$OUT/gateway-proxied"; rm -f "$prefix".run*
  for r in $(seq 1 "$RUNS"); do
    flush_redis_db
    check_load "gateway proxied run $r"
    echo "gateway through gateway run $r/$RUNS" >&2
    BASE=http://localhost:3100 k6_run "$prefix.run$r" "$ROOT/services/gateway/load/overhead.js"
  done
  emit "$(row "through gateway" "$prefix")"
  cpu_emit gateway-proxied
  stop_service "$SVC_PID"
  stop_service "$inv"
  flush_redis_db # the limiter keys of the last run must not stay in the shared database
}

NOTIF_HEADER="| Partitions consumed at once | Runs | Seconds median (min-max) | Deliveries/s median (min-max) | Sent / expected (distinct per-run values) | Duplicate rows (sum) | Dead letters (distinct per-run values, 10 expected) | Provider calls (distinct per-run values) | Runs failing an integrity check |
|---|---|---|---|---|---|---|---|---|"

notifications_psql() {
  if command -v psql >/dev/null; then psql -q "$DATABASE_URL" -c "$1" >/dev/null; return; fi
  local c=${PG_CONTAINER:-$(container_for_port 55432)}
  [ -n "$c" ] || { echo "notifications cleanup needs psql or a Postgres container (PG_CONTAINER)" >&2; return 1; }
  docker exec "$c" psql -q -U lab -d lab -c "$1" >/dev/null
}
truncate_notifications() {
  # The schema is created by the first migrate (bench.js runs it), so on a fresh database it does not exist yet.
  notifications_psql "DO \$\$ BEGIN IF to_regclass('notifications.deliveries') IS NOT NULL THEN TRUNCATE notifications.deliveries; END IF; END \$\$"
}
# Also removes what an interrupted bench.js leaves (it deletes its own topics only on a normal end): topics payments-bench-* and groups g-<digits>.
notifications_cleanup() {
  NOTIF_DIRTY=0
  truncate_notifications 2>/dev/null || echo "note: notifications.deliveries was NOT truncated" >&2
  local c=${REDPANDA_CONTAINER:-$(container_for_port 59092)} t g
  [ -n "$c" ] || return 0
  for t in $(docker exec "$c" rpk topic list 2>/dev/null | awk '$1 ~ /^payments-bench-/ {print $1}'); do
    docker exec "$c" rpk topic delete "$t" >/dev/null 2>&1 || true
  done
  for g in $(docker exec "$c" rpk group list 2>/dev/null | awk '$2 ~ /^g-[0-9]+$/ {print $2}'); do
    docker exec "$c" rpk group delete "$g" >/dev/null 2>&1 || true
  done
}

# notifications_row <label> <prefix>: Markdown row from the JSON lines of bench.js in <prefix>.run*.json
notifications_row() {
  node - "$1" "$2" <<'JS'
const fs = require("fs"), path = require("path");
const [label, prefix] = process.argv.slice(2);
const dir = path.dirname(prefix), base = path.basename(prefix);
const files = fs.readdirSync(dir).filter((f) => f.startsWith(base + ".run") && f.endsWith(".json")).sort();
const runs = files.map((f) => ({ r: JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")), rc: Number(fs.readFileSync(`${dir}/${f.replace(/\.json$/, ".rc")}`, "utf8")) }));
const stat = (xs, d) => {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  const med = n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  return `${med.toFixed(d)} (${s[0].toFixed(d)}-${s[n - 1].toFixed(d)})`;
};
const bad = runs.filter(({ r, rc }) => rc !== 0 || r.deliveries_sent !== r.deliveries_expected || r.duplicate_rows !== 0 || r.dlq_messages !== 10).length;
const uniq = (xs) => [...new Set(xs)].join(", ");
console.log(`| ${label} | ${runs.length} | ${stat(runs.map((x) => x.r.seconds), 1)} | ${stat(runs.map((x) => x.r.deliveries_per_s), 0)} | ${uniq(runs.map((x) => `${x.r.deliveries_sent}/${x.r.deliveries_expected}`))} | ${runs.reduce((a, x) => a + x.r.duplicate_rows, 0)} | ${uniq(runs.map((x) => x.r.dlq_messages))} | ${uniq(runs.map((x) => x.r.send_calls))} | ${bad}/${runs.length} |`);
JS
}

bench_notifications() {
  table_begin "notifications (load/bench.js, ${N:-20000} unique events + duplicates + 10 poison, ${SENDER_LATENCY_MS:-20} ms provider, CONCURRENCY ${CONCURRENCY:-25}; needs Redpanda)" "$NOTIF_HEADER"
  local parts r prefix rc line
  NOTIF_DIRTY=1
  for parts in 1 3; do
    prefix="$OUT/notifications-parts$parts"; rm -f "$prefix".run*
    for r in $(seq 1 "$RUNS"); do
      # bench.js creates its own topic (3 partitions) and group per run; the deliveries table must be empty or the previous run's rows would count.
      truncate_notifications
      check_load "notifications parts=$parts run $r"
      echo "notifications parts=$parts run $r/$RUNS" >&2
      rc=0
      cpu_start "$prefix.run$r"
      PARTS=$parts DATABASE_URL="$DATABASE_URL" node "$ROOT/services/notifications/load/bench.js" >"$prefix.run$r.out" 2>&1 || rc=$?
      cpu_stop
      echo "$rc" >"$prefix.run$r.rc"
      # bench.js prints one JSON line starting with "events_produced" (kafkajs also logs JSON lines; "timeout at <n>" precedes it when the run did not finish).
      line=$(grep '^{"events_produced"' "$prefix.run$r.out" | tail -n 1 || true)
      if [ -z "$line" ]; then echo "bench.js produced no result (exit $rc):" >&2; tail -n 20 "$prefix.run$r.out" >&2; exit 1; fi
      printf '%s\n' "$line" >"$prefix.run$r.json"
      echo "$line" >&2
    done
    emit "$(notifications_row "$parts" "$prefix")"
    cpu_emit "notifications-parts$parts"
  done
  notifications_cleanup
}

case "$SCENARIO" in
  inventory) bench_inventory ;;
  waiting-room) bench_waiting_room ;;
  payments) bench_payments ;;
  catalog) bench_catalog ;;
  gateway) bench_gateway ;;
  notifications) bench_notifications ;;
  all) bench_inventory; bench_waiting_room; bench_payments; bench_catalog; bench_gateway; bench_notifications ;;
esac
echo >&2
echo "raw summaries and table.md: $OUT" >&2
