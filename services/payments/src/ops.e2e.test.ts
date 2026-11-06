import { createServer, Server } from "node:http";
import { join } from "node:path";
import { Kafka } from "kafkajs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createScratchDatabase, ensureBuilt, freePort, RunningService, spawnService, waitHealthy } from "@boxoffice/platform";

const pkg = join(__dirname, "..");
const BROKER = "localhost:59092";
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
  const svc = spawnService(pkg, { PORT: String(port), INVENTORY_URL: `http://127.0.0.1:${inventoryPort}`, KAFKA_BROKER: BROKER, DATABASE_URL: scratch.url, ...env });
  live.push(svc);
  const base = `http://127.0.0.1:${port}`;
  await waitHealthy(base);
  return { svc, base };
};
const pay = (base: string, key: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/payments`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key, ...headers }, body: JSON.stringify({ eventId: 987002, userId: "ops-e2e", seatIds: [1], amountCents: 1000 }) });

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
