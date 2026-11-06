// Overhead of the platform instrumentation (RED metrics hooks + trace context + request log) on one Fastify route.
// Method: the same trivial route is served three ways, each in its own run, on loopback, driven by a keep-alive client with
// CONC concurrent connections for SECONDS seconds; runs alternate A,B,C,A,B,C... ROUNDS times so drift hits all variants.
//   bare        Fastify only
//   instrumented  + instrumentFastify (in-flight gauge, counter, histogram, request context, x-request-id)
//   debug-logs  + instrumented, LOG_LEVEL=debug, one JSON line per request written to /dev/null
// Usage: pnpm -r build && node ops/overhead.mjs   (CONC, SECONDS, ROUNDS env to change)
import { createRequire } from "node:module";
import { Agent, request } from "node:http";
import { createWriteStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(join(root, "packages/platform/package.json"));
const Fastify = req("fastify");
const platform = req("./dist/index.js");
const CONC = Number(process.env.CONC ?? 50), SECONDS = Number(process.env.SECONDS ?? 5), ROUNDS = Number(process.env.ROUNDS ?? 3);

async function serve(variant) {
  const app = Fastify({ logger: false });
  const sink = createWriteStream("/dev/null");
  if (variant !== "bare") {
    platform.setRootLogger(platform.createLogger({ service: "bench", level: variant === "debug-logs" ? "debug" : "info", write: (l) => sink.write(l + "\n") }));
    platform.instrumentFastify(app);
  }
  app.get("/events/:id/availability", async () => ({ free: 1, held: 2, sold: 3 }));
  await app.listen({ port: 0, host: "127.0.0.1" });
  return { app, port: app.server.address().port, sink };
}

async function drive(port) {
  const agent = new Agent({ keepAlive: true, maxSockets: CONC });
  const lat = [];
  const end = Date.now() + SECONDS * 1000;
  let n = 0;
  const one = () => new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    request({ port, host: "127.0.0.1", path: "/events/7/availability", agent }, (res) => { res.resume(); res.on("end", () => { lat.push(Number(process.hrtime.bigint() - t0) / 1e6); resolve(); }); }).on("error", reject).end();
  });
  await Promise.all(Array.from({ length: CONC }, async () => { while (Date.now() < end) { await one(); n++; } }));
  agent.destroy();
  lat.sort((a, b) => a - b);
  return { rps: n / SECONDS, p50: lat[Math.floor(lat.length * 0.5)], p99: lat[Math.floor(lat.length * 0.99)] };
}

const results = { bare: [], instrumented: [], "debug-logs": [] };
for (let r = 0; r < ROUNDS; r++) {
  for (const v of Object.keys(results)) {
    const s = await serve(v);
    await drive(s.port); // warm-up run is discarded
    results[v].push(await drive(s.port));
    await s.app.close(); s.sink.end();
  }
}
console.log(`node ${process.version}, ${process.platform}/${process.arch}, CONC=${CONC}, ${SECONDS}s per run, ${ROUNDS} rounds (client and server share one machine and one event loop pair)`);
for (const [v, rs] of Object.entries(results)) console.log(v.padEnd(13), rs.map((x) => `${Math.round(x.rps)} rps p50 ${x.p50.toFixed(2)}ms p99 ${x.p99.toFixed(2)}ms`).join(" | "));
