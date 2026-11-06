// Drill 5: a channel is down, messages dead-letter; the cause is fixed and the DLQ is replayed.
// Expect: every notification delivered exactly once per channel, channels that already worked are NOT resent.
// Usage: pnpm --filter @boxoffice/notifications build && node drills/dlq-replay.mjs
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { Kafka } = require("../services/notifications/node_modules/kafkajs");
const { createPool, migrate } = require("../services/notifications/dist/db");
const { NotificationHandler } = require("../services/notifications/dist/handler");
const { runConsumer } = require("../services/notifications/dist/consumer");
const { replayDlq } = require("../services/notifications/dist/replay-dlq");

const BROKER = "localhost:59092", TOPIC = `replay-${Date.now()}`, N = 200;
const kafka = new Kafka({ clientId: "drill", brokers: [BROKER] });
const admin = kafka.admin(); await admin.connect();
await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 3 }, { topic: `${TOPIC}.dlq`, numPartitions: 1 }] });
const pool = createPool(10); await migrate(pool); await pool.query("TRUNCATE notifications.deliveries");

let emailDown = true; const sends = { email: 0, push: 0 };
const send = async (ch) => { if (ch === "email" && emailDown) throw new Error("smtp down"); sends[ch]++; };
const handler = new NotificationHandler(pool, send, { maxAttempts: 2, backoffMs: 1 });

const producer = kafka.producer(); await producer.connect();
await producer.send({ topic: TOPIC, messages: Array.from({ length: N }, (_, i) => ({ key: String(i + 1), value: JSON.stringify({ outboxId: i + 1, eventType: "payment.confirmed", paymentId: i + 1, userId: `u${i}`, seatIds: [i] }) })) });

const c = await runConsumer(handler, { broker: BROKER, topic: TOPIC, groupId: `g-${TOPIC}`, concurrency: 25, partitionsConcurrently: 3 });
const q = (s) => Number(execSync(`docker exec boxoffice-lab-postgres-1 psql -U lab -tAc "${s}"`, { encoding: "utf8" }).trim());
for (let i = 0; i < 60 && q("select count(*) from notifications.deliveries where channel='push' and status='SENT'") < N; i++) await new Promise((r) => setTimeout(r, 500));
await new Promise((r) => setTimeout(r, 1500));
const [dl] = await admin.fetchTopicOffsets(`${TOPIC}.dlq`);
console.log(`email DOWN: push sent=${sends.push}, email sent=${sends.email}, dead-lettered=${dl.high}`);

emailDown = false;
const replayed = await replayDlq(BROKER, TOPIC, 2500);
for (let i = 0; i < 60 && q("select count(*) from notifications.deliveries where channel='email' and status='SENT'") < N; i++) await new Promise((r) => setTimeout(r, 500));
console.log(`email FIXED, ${replayed} messages replayed: email sent=${sends.email}, push sent=${sends.push} (push must still be ${N}: not resent)`);
console.log(`deliveries SENT: ${q("select count(*) from notifications.deliveries where status='SENT'")} of ${N * 2}; duplicate rows: ${q("select count(*) from (select 1 from notifications.deliveries group by outbox_id, channel having count(*)>1) x")}; not SENT: ${q("select count(*) from notifications.deliveries where status<>'SENT'")}`);
await c.stop(); await producer.disconnect(); await admin.deleteTopics({ topics: [TOPIC, `${TOPIC}.dlq`] }); await admin.disconnect(); await pool.end(); process.exit(0);
