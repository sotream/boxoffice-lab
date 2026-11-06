// Usage: pnpm build && node load/bench.js   (needs docker compose up -d postgres redpanda)
const { Kafka } = require("kafkajs");
const { createPool, migrate } = require("../dist/db");
const { NotificationHandler } = require("../dist/handler");
const { runConsumer } = require("../dist/consumer");

const N = Number(process.env.N || 20000);
const LATENCY = Number(process.env.SENDER_LATENCY_MS || 20);
const CONC = Number(process.env.CONCURRENCY || 25);
const TOPIC = `payments-bench-${Date.now()}`;
const BROKER = "localhost:59092";

(async () => {
  const kafka = new Kafka({ clientId: "bench", brokers: [BROKER] });
  const admin = kafka.admin(); await admin.connect();
  await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 3 }, { topic: `${TOPIC}.dlq`, numPartitions: 1 }] });
  const pool = createPool(30); await migrate(pool);
  await pool.query("TRUNCATE notifications.deliveries");

  // 20k events: ids 1..N, 5% duplicated, 10 poison (invalid JSON); every 201st event's email send fails twice (transient).
  const producer = kafka.producer(); await producer.connect();
  const msgs = [];
  for (let i = 1; i <= N; i++) {
    const v = JSON.stringify({ outboxId: i, eventType: i % 10 === 0 ? "payment.failed" : "payment.confirmed", paymentId: i, userId: `u${i}`, seatIds: [i] });
    msgs.push({ key: String(i), value: v });
    if (i % 20 === 0) msgs.push({ key: String(i), value: v }); // duplicate delivery
  }
  for (let i = 0; i < 10; i++) msgs.push({ key: `bad${i}`, value: "{not json" });
  for (let i = 0; i < msgs.length; i += 5000) await producer.send({ topic: TOPIC, messages: msgs.slice(i, i + 5000) });

  let sendCalls = 0; const flaky = new Map();
  const send = async (ch, _to, _t, key) => {
    sendCalls++;
    if (LATENCY) await new Promise((r) => setTimeout(r, LATENCY));
    if (ch === "email" && Number(key.split(":")[0]) % 201 === 0 && (flaky.get(key) || 0) < 2) { flaky.set(key, (flaky.get(key) || 0) + 1); throw new Error("smtp 503"); }
  };
  const handler = new NotificationHandler(pool, send, { backoffMs: 5 });

  const t0 = Date.now();
  const c = await runConsumer(handler, { broker: BROKER, topic: TOPIC, groupId: `g-${Date.now()}`, concurrency: CONC, partitionsConcurrently: Number(process.env.PARTS || 1) });
  // expected deliveries: confirmed(90%) -> 2 channels, failed(10%) -> 1 channel
  const expected = Math.round(N * 0.9) * 2 + Math.round(N * 0.1);
  for (;;) {
    const r = (await pool.query("SELECT count(*)::int c FROM notifications.deliveries WHERE status='SENT'")).rows[0].c;
    if (r >= expected) break;
    if (Date.now() - t0 > 300000) { console.log("timeout at", r); break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  const secs = (Date.now() - t0) / 1000;
  await new Promise((r) => setTimeout(r, 1000));
  const sent = (await pool.query("SELECT count(*)::int c FROM notifications.deliveries WHERE status='SENT'")).rows[0].c;
  const dup = (await pool.query("SELECT count(*)::int c FROM (SELECT outbox_id, channel FROM notifications.deliveries GROUP BY 1,2 HAVING count(*)>1) x")).rows[0].c;
  const [dl] = (await admin.fetchTopicOffsets(`${TOPIC}.dlq`));
  console.log(JSON.stringify({ events_produced: msgs.length, deliveries_expected: expected, deliveries_sent: sent, duplicate_rows: dup, send_calls: sendCalls, dlq_messages: Number(dl.high), seconds: +secs.toFixed(1), deliveries_per_s: Math.round(sent / secs), sender_latency_ms: LATENCY, concurrency: CONC, partitions_concurrently: Number(process.env.PARTS || 1), flaky_events: flaky.size }));
  await c.stop(); await producer.disconnect(); await admin.deleteTopics({ topics: [TOPIC, `${TOPIC}.dlq`] }); await admin.disconnect(); await pool.end(); process.exit(0);
})();
