// Drill 2: the broker is down while payments keep coming. Payments must keep succeeding, the outbox must
// buffer events, and after the broker returns every event must be published (at-least-once, nothing lost).
// Usage: node drills/kafka-down.mjs  (services: inventory 3101, payments 3103; docker compose redpanda + postgres)
import { execSync } from "node:child_process";
import { signInternal } from "./internal-sign.mjs";
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const psql = (q) => sh(`docker exec boxoffice-lab-postgres-1 psql -U lab -tAc "${q}"`);
const hw = () => Number(sh(`docker exec boxoffice-lab-redpanda-1 rpk topic describe payments -p | awk 'NR==2{print $6}'`));
const base = Number(psql("select count(*) from payments.outbox"));
const hw0 = hw();
console.log(`baseline: outbox=${base} topic_high_watermark=${hw0}`);

sh("docker stop boxoffice-lab-redpanda-1");
console.log("redpanda STOPPED; sending 300 payments");
let ok = 0, fail = 0; const t0 = Date.now();
await Promise.all(Array.from({ length: 300 }, async (_, i) => {
  try {
    const body = JSON.stringify({ eventId: 1, userId: `d${i}`, seatIds: [900000 + i] });
    const r = await fetch("http://localhost:3103/payments", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `drill-${Date.now()}-${i}`, ...signInternal("POST", "/payments", body) },
      body, signal: AbortSignal.timeout(10000) });
    r.status === 200 ? ok++ : fail++;
  } catch { fail++; }
}));
console.log(`payments while broker down: ok=${ok} failed=${fail} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`outbox unpublished: ${psql("select count(*) from payments.outbox where published_at is null")}`);

sh("docker start boxoffice-lab-redpanda-1");
const t1 = Date.now();
for (;;) {
  const left = Number(psql("select count(*) from payments.outbox where published_at is null"));
  if (left === 0) break;
  if (Date.now() - t1 > 120000) { console.log("timeout, unpublished left:", left); break; }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`caught up ${((Date.now() - t1) / 1000).toFixed(1)}s after broker start`);
const total = Number(psql("select count(*) from payments.outbox"));
console.log(`outbox rows=${total} (+${total - base}) topic_high_watermark=${hw()} (+${hw() - hw0})`);
