import { join } from "node:path";
import { Kafka } from "kafkajs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureBuilt, freePort, RunningService, spawnService, waitUntil } from "@boxoffice/platform";
import { createPool, migrate } from "./db";

const pkg = join(__dirname, "..");
const BROKER = "localhost:59092";
const TOPIC = `ops-e2e-${Date.now()}`;
const pool = createPool(3);
const kafka = new Kafka({ clientId: "ops-e2e", brokers: [BROKER] });
const live: RunningService[] = [];
const OUTBOX_ID = 7_000_000_000_000 + (Date.now() % 1_000_000);

beforeAll(async () => {
  ensureBuilt(pkg);
  await migrate(pool);
  const admin = kafka.admin(); await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 1 }, { topic: `${TOPIC}.dlq`, numPartitions: 1 }] });
  await admin.disconnect();
}, 60_000);
afterEach(() => { for (const s of live.splice(0)) s.child.kill("SIGKILL"); });
afterAll(async () => {
  await pool.query("DELETE FROM notifications.deliveries WHERE outbox_id = $1", [OUTBOX_ID]);
  await pool.end();
  const admin = kafka.admin(); await admin.connect();
  await admin.deleteTopics({ topics: [TOPIC, `${TOPIC}.dlq`] }).catch(() => undefined);
  await admin.disconnect();
});

const start = async () => {
  const opsPort = await freePort();
  const svc = spawnService(pkg, { OPS_PORT: String(opsPort), TOPIC, GROUP_ID: `g-${TOPIC}-${Math.random().toString(36).slice(2)}`, KAFKA_BROKER: BROKER, SENDER_LATENCY_MS: "5" });
  live.push(svc);
  const base = `http://127.0.0.1:${opsPort}`;
  await waitUntil(async () => (await fetch(`${base}/healthz`)).status === 200);
  return { svc, base };
};

describe("notifications process", () => {
  it("healthz/readyz/metrics; delivered, duplicate and dead-letter counters; the request id from the Kafka headers reaches the logs", async () => {
    const { svc, base } = await start();
    const ready = await (await fetch(`${base}/readyz`)).json();
    expect(ready.status).toBe("ready");
    expect(Object.keys(ready.checks).sort()).toEqual(["kafka", "postgres"]);

    const producer = kafka.producer(); await producer.connect();
    const ev = JSON.stringify({ outboxId: OUTBOX_ID, eventType: "payment.confirmed", paymentId: 1, userId: "ops-e2e-u", seatIds: [1] });
    const h = { "x-request-id": "rid-notify-1", traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" };
    await producer.send({ topic: TOPIC, messages: [{ key: "1", value: ev, headers: h }, { key: "1", value: ev, headers: h }, { key: "2", value: "not json", headers: { "x-request-id": "rid-poison-1" } }] });
    await producer.disconnect();

    await waitUntil(async () => {
      const t = await (await fetch(`${base}/metrics`)).text();
      return /notifications_dlq_total\{service="notifications"\} 1/.test(t) && /notifications_delivered_total\{channel="push",service="notifications"\} 1/.test(t) && /notifications_duplicate_suppressed_total\{channel="push"/.test(t);
    }, 30_000);
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toMatch(/notifications_delivered_total\{channel="email",service="notifications"\} 1/);
    expect(text).toMatch(/notifications_delivered_total\{channel="push",service="notifications"\} 1/);
    expect(text).toMatch(/notifications_duplicate_suppressed_total\{channel="(email|push)",service="notifications"\} [1-9]/);
    expect(text).toContain("notifications_consumer_lag_messages");
    expect(text).toContain('pg_pool_total_connections{pool="main"');
    expect(svc.output()).toMatch(/"msg":"message dead-lettered".*"requestId":"rid-poison-1"/);
    expect(text).not.toContain("ops-e2e-u");
  }, 60_000);

  it("SIGTERM: the consumer leaves the group cleanly and the process exits 0", async () => {
    const { svc } = await start();
    svc.child.kill("SIGTERM");
    const exit = await svc.exited;
    expect(exit.code).toBe(0);
    for (const step of ["consumer (finish the current batch, leave the group)", "postgres pools", "ops server"]) expect(svc.output()).toContain(step);
  }, 40_000);

  it("a taken ops port does not stop the consumer", async () => {
    const { createServer } = await import("node:http");
    const blocker = createServer(); const port = await freePort();
    await new Promise<void>((r) => blocker.listen(port, "0.0.0.0", r));
    const svc = spawnService(pkg, { OPS_PORT: String(port), TOPIC, GROUP_ID: `g2-${TOPIC}`, KAFKA_BROKER: BROKER });
    live.push(svc);
    await waitUntil(async () => svc.output().includes("ops server not started"), 30_000);
    expect(svc.child.exitCode).toBeNull();
    blocker.close();
  }, 40_000);
});
