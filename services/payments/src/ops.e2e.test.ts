import { createServer, Server } from "node:http";
import { join } from "node:path";
import { Kafka } from "kafkajs";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createScratchDatabase, ensureBuilt, freePort, RunningService, signInternalRequest, spawnService, waitHealthy } from "@boxoffice/platform";

const pkg = join(__dirname, "..");
const BROKER = "localhost:59092";
const TOKEN = "ops-e2e-internal-token";
// The spawned service runs a sweeper and an outbox relay over the whole database, so it gets a private database:
// otherwise it would resume and publish rows that other tests in the shared lab database are asserting on.
let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
const live: RunningService[] = [];
let inventory: Server;
let inventoryPort: number;
const seenInventory: Record<string, string | string[] | undefined>[] = [];

beforeAll(async () => {
  ensureBuilt(pkg);
  scratch = await createScratchDatabase("ops_e2e_payments");
  inventory = createServer((req, res) => { seenInventory.push(req.headers); req.resume(); req.on("end", () => res.writeHead(200, { "content-type": "application/json" }).end("{}")); });
  await new Promise<void>((r) => inventory.listen(0, "127.0.0.1", r));
  inventoryPort = (inventory.address() as any).port;
  const admin = new Kafka({ clientId: "ops-e2e", brokers: [BROKER] }).admin();
  await admin.connect();
  if (!(await admin.listTopics()).includes("payments")) await admin.createTopics({ topics: [{ topic: "payments", numPartitions: 1 }] });
  await admin.disconnect();
}, 60_000);
afterEach(() => { for (const s of live.splice(0)) s.child.kill("SIGKILL"); });
afterAll(async () => { inventory.close(); await scratch.drop(); });

const start = async (env: Record<string, string> = {}) => {
  const port = await freePort();
  const svc = spawnService(pkg, { PORT: String(port), INVENTORY_URL: `http://127.0.0.1:${inventoryPort}`, KAFKA_BROKER: BROKER, DATABASE_URL: scratch.url, PAYMENTS_INTERNAL_TOKEN: TOKEN, SEAT_PRICE_CENTS: "1000", ...env });
  live.push(svc);
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base);
  return { svc, base };
};
/** The request signature the gateway would add: HMAC over timestamp, method, path and the exact body. */
const sign = (path: string, body: string, secret = TOKEN, now = Date.now()) => ({ "x-internal-auth": signInternalRequest(secret, "POST", path, body, now) });
const pay = (base: string, key: string, headers: Record<string, string> = {}) => {
  const body = JSON.stringify({ eventId: 987002, userId: "ops-e2e", seatIds: [1], amountCents: 1000 });
  return fetch(`${base}/payments`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, ...sign("/payments", body), ...headers }, body });
};

describe("payments process", () => {
  it("healthz/readyz/metrics; one request id follows the purchase into inventory and into the Kafka headers", async () => {
    const { base } = await start({ PSP_LATENCY_MS: "10" });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    const ready = await (await fetch(`${base}/readyz`)).json();
    expect(ready.status).toBe("ready");
    expect(ready.checks.kafka.critical).toBe(false);

    const kafka = new Kafka({ clientId: "ops-e2e-consumer", brokers: [BROKER] });
    const consumer = kafka.consumer({ groupId: `ops-e2e-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: "payments", fromBeginning: false });
    const rid = `ops-e2e-${Date.now()}`;
    const found = new Promise<Record<string, string>>((resolve) => {
      void consumer.run({ eachMessage: async ({ message }) => {
        const h = Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [k, String(v)]));
        if (h["x-request-id"] === rid) resolve(h);
      } });
    });
    const tp = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const res = await pay(base, `ops-e2e-${rid}`, { "x-request-id": rid, traceparent: tp });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("CONFIRMED");
    expect(res.headers.get("x-request-id")).toBe(rid);

    const hdr = await Promise.race([found, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no kafka message with the request id")), 20_000))]);
    await consumer.disconnect();
    expect(hdr.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    // and the synchronous hop to inventory carried the same ids
    const inv = seenInventory.find((h) => h["x-request-id"] === rid);
    expect(inv).toBeDefined();
    expect(String(inv!.traceparent)).toContain("4bf92f3577b34da6a3ce929d0e0e4736");

    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toMatch(/payments_final_total\{status="CONFIRMED",service="payments"\} 1/);
    expect(text).toMatch(/payments_outbox_published_total\{service="payments"\} [1-9]/);
    expect(text).toContain("payments_outbox_backlog");
    expect(text).toContain("payments_outbox_oldest_unpublished_age_seconds");
    expect(text).toMatch(/payments_sagas\{state="CONFIRMED",service="payments"\} [1-9]/);
    expect(text).toContain('pg_pool_total_connections{pool="relay"');
    expect(text).not.toContain("ops-e2e-ops");
  }, 60_000);

  it("a slow PSP gives a 202 that is counted, and the sweeper finishes the saga", async () => {
    const { base } = await start({ PSP_LATENCY_MS: "1500", PSP_TIMEOUT_MS: "300", PSP_ADMIN: "1" });
    const key = `ops-e2e-slow-${Date.now()}`;
    expect((await pay(base, key)).status).toBe(202);
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toMatch(/payments_in_progress_total\{service="payments"\} 1/);
  }, 30_000);

  it("internal authentication, server-side price and key scoping on the running service", async () => {
    const { base } = await start({ PSP_ADMIN: "1" });
    const db = new Pool({ connectionString: scratch.url, max: 1 });
    try {
      const rowsFor = async (key: string) => (await db.query("SELECT user_id, amount_cents FROM payments.payments WHERE idempotency_key LIKE $1", [`%:${key}`])).rows.sort((a, b) => a.user_id.localeCompare(b.user_id));
      const post = (path: string, headers: Record<string, string>, body: string) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
      const good = JSON.stringify({ eventId: 987002, userId: "ops-e2e", seatIds: [1, 2] });
      const key = `ops-e2e-auth-${Date.now()}`;

      // 401 without or with a wrong token, before the body is looked at and before any row is written
      expect((await post("/payments", { "idempotency-key": key }, good)).status).toBe(401);
      expect((await post("/payments", { "idempotency-key": key, ...sign("/payments", good, "wrong") }, good)).status).toBe(401);
      // a valid signature does not carry over to another body, another path or a later time
      expect((await post("/payments", { "idempotency-key": key, ...sign("/payments", good) }, JSON.stringify({ ...JSON.parse(good), seatIds: [1, 2, 3] }))).status).toBe(401);
      expect((await post("/payments", { "idempotency-key": key, ...sign("/admin/psp", good) }, good)).status).toBe(401);
      expect((await post("/payments", { "idempotency-key": key, ...sign("/payments", good, TOKEN, Date.now() - 60_000) }, good)).status).toBe(401);
      expect((await post("/payments", { "idempotency-key": key }, "{not json")).status).toBe(401);
      expect((await post("/payments", {}, "{}")).status).toBe(401); // not even the missing key (400) is reported to an unauthenticated caller
      expect(await rowsFor(key)).toEqual([]);

      // probes stay open; the admin endpoint needs the token as well
      for (const p of ["/healthz", "/readyz", "/metrics"]) expect((await fetch(`${base}${p}`)).status, p).toBe(200);
      expect((await post("/admin/psp", {}, '{"latencyMs":5}')).status).toBe(401);
      const admin = await post("/admin/psp", sign("/admin/psp", '{"latencyMs":5}'), '{"latencyMs":5}');
      expect(admin.status).toBe(201);
      expect(await admin.json()).toEqual({ ok: true, latencyMs: 5 });

      // a tampered amount is a 400 and nothing is charged; no amount at all is priced by the server (2 seats x 1000)
      const auth = (body: string) => ({ "idempotency-key": key, ...sign("/payments", body) });
      const tampered = JSON.stringify({ ...JSON.parse(good), amountCents: 1 });
      expect((await post("/payments", auth(tampered), tampered)).status).toBe(400);
      expect(await rowsFor(key)).toEqual([]);
      const ok = await post("/payments", auth(good), good);
      expect(ok.status).toBe(200);
      const first = await ok.json();
      expect(first.status).toBe("CONFIRMED");
      expect(await rowsFor(key)).toEqual([{ user_id: "ops-e2e", amount_cents: 2000 }]);

      // the same key and request again: the stored result; another user with that key gets an independent payment of their own
      const again = await post("/payments", auth(good), good);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(first);
      const mallory = JSON.stringify({ eventId: 987002, userId: "mallory", seatIds: [1, 2] });
      const other = await post("/payments", auth(mallory), mallory);
      expect(other.status).toBe(200);
      const otherBody = await other.json();
      expect(otherBody.paymentId).not.toBe(first.paymentId);
      expect(await rowsFor(key)).toEqual([{ user_id: "mallory", amount_cents: 2000 }, { user_id: "ops-e2e", amount_cents: 2000 }]);
    } finally { await db.end(); }
  }, 60_000);

  it("refuses to boot with the development token in production and with a bad price", async () => {
    for (const env of [{ NODE_ENV: "production" }, { NODE_ENV: "production", PAYMENTS_INTERNAL_TOKEN: "dev-internal-token" }]) {
      const svc = spawnService(pkg, { DATABASE_URL: scratch.url, KAFKA_BROKER: BROKER, PORT: String(await freePort()), ...env, PAYMENTS_INTERNAL_TOKEN: (env as Record<string, string>).PAYMENTS_INTERNAL_TOKEN ?? "" });
      live.push(svc);
      expect((await svc.exited).code).toBe(78);
      expect(svc.output()).toMatch(/PAYMENTS_INTERNAL_TOKEN (must be set when NODE_ENV=production|is set to a known development value)/);
    }
    const bad = spawnService(pkg, { DATABASE_URL: scratch.url, KAFKA_BROKER: BROKER, PORT: String(await freePort()), SEAT_PRICE_CENTS: "0" });
    live.push(bad);
    expect((await bad.exited).code).toBe(78);
    expect(bad.output()).toMatch(/SEAT_PRICE_CENTS must be >= 1/);
    // ADR 007: a sweeper threshold that does not clear the pre-charge check by the margin is refused, together with the other problems
    const racy = spawnService(pkg, { DATABASE_URL: scratch.url, KAFKA_BROKER: BROKER, PORT: String(await freePort()), SWEEP_MIN_AGE_MS: "2000", SEAT_PRICE_CENTS: "0" });
    live.push(racy);
    expect((await racy.exited).code).toBe(78);
    expect(racy.output()).toMatch(/SWEEP_MIN_AGE_MS \(2000\) must be at least 2500[\s\S]*SEAT_PRICE_CENTS must be >= 1/);
  }, 30_000);

  it("SIGTERM during an in-flight payment: it completes, relay and sweeper stop, the process exits 0", async () => {
    const { svc, base } = await start({ PSP_LATENCY_MS: "900", PSP_TIMEOUT_MS: "5000", SHUTDOWN_DEADLINE_MS: "8000" });
    const inflight = pay(base, `ops-e2e-drain-${Date.now()}`, { connection: "close" });
    await new Promise((r) => setTimeout(r, 300));
    svc.child.kill("SIGTERM");
    const res = await inflight;
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("CONFIRMED");
    const exit = await svc.exited;
    expect(exit.code).toBe(0);
    for (const step of ["sweeper", "outbox relay", "kafka producer", "postgres pools"]) expect(svc.output()).toContain(`"step":"${step}"`);
  }, 40_000);
});
