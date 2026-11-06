// Drill 1: Redis dies while traffic flows through the gateway (rate limiter state + waiting-room state live in Redis).
// Usage: node drills/redis-down.mjs   (services: inventory 3101, waiting-room 3102, gateway 3100; docker compose redis)
import { execSync } from "node:child_process";
const BASE = "http://localhost:3100";
const buckets = new Map();
const note = (sec, key) => { const b = buckets.get(sec) ?? {}; b[key] = (b[key] ?? 0) + 1; buckets.set(sec, b); };
const t0 = Date.now();
let stop = false;
async function client() {
  while (!stop) {
    const sec = Math.floor((Date.now() - t0) / 1000);
    try {
      const r = await fetch(`${BASE}/events/1/availability`, { signal: AbortSignal.timeout(2000) });
      note(sec, r.status === 200 ? "ok" : `http${r.status}`);
    } catch { note(sec, "error"); }
    await new Promise((r) => setTimeout(r, 20));
  }
}
const clients = Array.from({ length: 20 }, client);
setTimeout(() => { execSync("docker stop boxoffice-lab-redis-1"); console.log(`t=${((Date.now()-t0)/1000).toFixed(1)}s redis STOPPED`); }, 5000);
setTimeout(() => { execSync("docker start boxoffice-lab-redis-1"); console.log(`t=${((Date.now()-t0)/1000).toFixed(1)}s redis STARTED`); }, 15000);
setTimeout(() => { stop = true; }, 25000);
await Promise.all(clients);
for (const [s, b] of [...buckets].sort((a, b) => a[0] - b[0])) console.log(String(s).padStart(2), JSON.stringify(b));
