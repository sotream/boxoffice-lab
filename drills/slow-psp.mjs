// Drill 4: the payment provider becomes slow (not dead). Measures what clients see, how many DB connections the
// service holds meanwhile, and how long after recovery every payment reaches a final state.
// Usage: node drills/slow-psp.mjs [slowMs=3000]   (needs inventory 3101 and payments 3103 with PSP_ADMIN=1 running)
import { execSync } from "node:child_process";
const SLOW = Number(process.argv[2] ?? 3000), N = 300, CLIENTS = 100;
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const psql = (q) => sh(`docker exec boxoffice-lab-postgres-1 psql -U lab -tAc "${q}"`);
const post = (url, body, headers = {}, ms = 20000) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
const psp = (latencyMs) => post("http://localhost:3103/admin/psp", { latencyMs });
const run = Date.now();

await psp(0);
// every payment gets a held seat, so the happy path (charge, confirm) is what we measure
await Promise.all(Array.from({ length: N }, (_, i) => post("http://localhost:3101/events/1/holds", { seatIds: [10000 + run % 1000 * 0 + i], userId: `s${i}` })));
await psp(SLOW);
const lat = [], codes = {};
let next = 0, peakConn = 0, stop = false;
const sampler = (async () => { while (!stop) { peakConn = Math.max(peakConn, Number(psql("select count(*) from pg_stat_activity where datname='lab' and state<>'idle' and application_name<>'psql'"))); await new Promise((r) => setTimeout(r, 300)); } })();
const t0 = Date.now();
await Promise.all(Array.from({ length: CLIENTS }, async () => {
  for (let i = next++; i < N; i = next++) {
    const s = Date.now();
    try {
      const r = await post("http://localhost:3103/payments", { eventId: 1, userId: `s${i}`, seatIds: [10000 + i], amountCents: 100 }, { "idempotency-key": `slow-${run}-${i}` }, 15000);
      const b = await r.json().catch(() => ({}));
      const k = `${r.status}${b.status ? ":" + b.status : ""}${b.inProgress ? "(in-progress)" : ""}`;
      codes[k] = (codes[k] ?? 0) + 1;
    } catch { codes.client_timeout = (codes.client_timeout ?? 0) + 1; }
    lat.push(Date.now() - s);
  }
}));
stop = true; await sampler;
lat.sort((a, b) => a - b);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))];
console.log(`slow PSP ${SLOW} ms, ${N} payments, ${CLIENTS} clients, took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`client latency p50=${q(0.5)} p95=${q(0.95)} max=${lat[lat.length - 1]} ms; responses ${JSON.stringify(codes)}`);
console.log(`peak active DB connections of the lab database during the slow phase: ${peakConn}`);

await psp(0);
const t1 = Date.now();
for (;;) {
  const open = Number(psql(`select count(*) from payments.payments where idempotency_key like 'slow-${run}-%' and status not in ('CONFIRMED','REFUNDED','FAILED')`));
  if (open === 0) break;
  if (Date.now() - t1 > 60000) { console.log(`after recovery still not final after 60 s: ${open}`); break; }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`PSP recovered; all payments final ${((Date.now() - t1) / 1000).toFixed(1)}s later`);
console.log("final states:", psql(`select status||'='||count(*) from payments.payments where idempotency_key like 'slow-${run}-%' group by status`).replace(/\n/g, ", "));
console.log("duplicate charges (idempotency keys with >1 row):", psql(`select count(*) from (select 1 from payments.payments where idempotency_key like 'slow-${run}-%' group by idempotency_key having count(*)>1) x`));
