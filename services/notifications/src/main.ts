import { createShutdown, initService, loadConfigOrExit, pgCheck, Readiness, registerPoolMetrics, shutdownEnv, startOpsServer, tcpCheck } from "@boxoffice/platform";
import { runConsumer } from "./consumer";
import { createPool, migrate } from "./db";
import { NotificationHandler } from "./handler";

async function main() {
  const log = initService("notifications");
  const cfg = loadConfigOrExit((e) => ({
    opsPort: e.port("OPS_PORT", 3105),
    senderLatencyMs: e.num("SENDER_LATENCY_MS", 20, { min: 0 }),
    broker: e.hostPort("KAFKA_BROKER", "localhost:59092"),
    topic: e.str("TOPIC", "payments"),
    groupId: e.str("GROUP_ID", "notifications"),
    concurrency: e.int("CONCURRENCY", 25, { min: 1 }),
    pgPool: e.int("PG_POOL", 20, { min: 1 }),
    shutdown: shutdownEnv(e)
  }));
  const migrationPool = createPool(1, 0); // migrations: no statement timeout
  await migrate(migrationPool);
  await migrationPool.end();

  const pool = createPool(cfg.pgPool);
  registerPoolMetrics(pool, "main");
  const healthPool = createPool(1);
  const latency = cfg.senderLatencyMs;
  const handler = new NotificationHandler(pool, async () => { if (latency) await new Promise((r) => setTimeout(r, latency)); });
  const consumer = await runConsumer(handler, { broker: cfg.broker, topic: cfg.topic, groupId: cfg.groupId, concurrency: cfg.concurrency });

  // No HTTP API here, so a tiny server carries the ops endpoints. A port clash (a second consumer on the same host, as the drills start)
  // must not stop the consumer: it only loses its probe endpoints.
  const readiness = new Readiness([pgCheck(healthPool), tcpCheck(cfg.broker, "kafka")], { cacheMs: 1000 });
  const ops = await startOpsServer(cfg.opsPort, readiness).catch((e) => { log.warn("ops server not started", { err: e, port: cfg.opsPort }); return undefined; });

  const shutdown = createShutdown({ ...cfg.shutdown, readiness });
  shutdown.add("consumer (finish the current batch, leave the group)", () => consumer.stop());
  shutdown.add("postgres pools", async () => { await Promise.all([pool.end(), healthPool.end()]); });
  shutdown.add("ops server", () => new Promise<void>((r) => { if (!ops) return r(); ops.close(() => r()); ops.closeAllConnections(); }));
  shutdown.install();
  log.info("consuming", { topic: cfg.topic, group: cfg.groupId, opsPort: ops ? cfg.opsPort : null });
}
main().catch((e) => { console.error(e); process.exit(1); });
