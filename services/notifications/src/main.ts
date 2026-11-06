import { runConsumer } from "./consumer";
import { createPool, migrate } from "./db";
import { NotificationHandler } from "./handler";

async function main() {
  const pool = createPool();
  await migrate(pool);
  const latency = Number(process.env.SENDER_LATENCY_MS ?? 20);
  const handler = new NotificationHandler(pool, async () => { if (latency) await new Promise((r) => setTimeout(r, latency)); });
  await runConsumer(handler, {
    broker: process.env.KAFKA_BROKER ?? "localhost:59092",
    topic: process.env.TOPIC ?? "payments",
    groupId: process.env.GROUP_ID ?? "notifications",
    concurrency: Number(process.env.CONCURRENCY ?? 25)
  });
}
main();
