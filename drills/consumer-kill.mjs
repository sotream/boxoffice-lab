// Drill 3: SIGKILL the notifications consumer in the middle of a backlog, restart it, check nothing is lost
// and nothing is sent twice (except through the documented lease window).
// Usage: node drills/consumer-kill.mjs   (needs: pnpm --filter @boxoffice/notifications build, docker postgres + redpanda)
import { spawn, execSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Kafka } = require("../services/notifications/node_modules/kafkajs");
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const psql = (q) => sh(`docker exec boxoffice-lab-postgres-1 psql -U lab -tAc "${q}"`);
const N = 6000, TOPIC = `drill-${Date.now()}`, GROUP = `g-${TOPIC}`;

const kafka = new Kafka({ clientId: "drill", brokers: ["localhost:59092"] });
const admin = kafka.admin(); await admin.connect();
await admin.createTopics({ topics: [{ topic: TOPIC, numPartitions: 3 }] });
psql("truncate notifications.deliveries");
const producer = kafka.producer(); await producer.connect();
const msgs = Array.from({ length: N }, (_, i) => ({ key: String(i + 1), value: JSON.stringify({ outboxId: i + 1, eventType: "payment.confirmed", paymentId: i + 1, userId: `u${i}`, seatIds: [i] }) }));
await producer.send({ topic: TOPIC, messages: msgs });
const expected = N * 2; // confirmed -> email + push

const start = () => spawn("node", ["services/notifications/dist/main.js"], { env: { ...process.env, TOPIC, GROUP_ID: GROUP, SENDER_LATENCY_MS: "20", CONCURRENCY: "25" }, stdio: "ignore" });
const sent = () => Number(psql("select count(*) from notifications.deliveries where status='SENT'"));
let c = start();
await new Promise((r) => setTimeout(r, 7000));
const before = sent();
c.kill("SIGKILL");
console.log(`consumer SIGKILLed with ${before}/${expected} delivered; in SENDING at kill: ${psql("select count(*) from notifications.deliveries where status='SENDING'")}`);
await new Promise((r) => setTimeout(r, 2000));
const t0 = Date.now();
c = start();
for (;;) {
  if (sent() >= expected) break;
  if (Date.now() - t0 > 180000) { console.log("timeout at", sent()); break; }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`restarted consumer finished ${((Date.now() - t0) / 1000).toFixed(1)}s later: delivered ${sent()}/${expected}`);
console.log(`duplicate (event,channel) rows: ${psql("select count(*) from (select 1 from notifications.deliveries group by outbox_id, channel having count(*)>1) x")}`);
console.log(`rows stuck in SENDING/FAILED: ${psql("select count(*) from notifications.deliveries where status<>'SENT'")}`);
c.kill("SIGKILL"); await producer.disconnect(); await admin.deleteTopics({ topics: [TOPIC] }); await admin.disconnect(); process.exit(0);
