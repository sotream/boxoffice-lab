import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { Kafka } from "kafkajs";
import { createShutdown, drainHttp, initService, loadConfigOrExit, pgCheck, Readiness, registerPoolMetrics, shutdownEnv, startLoop, tcpCheck, wireNest } from "@boxoffice/platform";
import { AppModule, pool } from "./app.module";
import { PaymentsService } from "./payments.service";
import { createPool, migrate } from "./db";
import { outboxPublished, outboxRelayErrors, registerOutboxGauges, registerSagaGauge, sweeperResumed, sweeperRuns } from "./metrics";
import { OutboxRelay } from "./outbox-relay";

async function bootstrap() {
  const log = initService("payments");
  const cfg = loadConfigOrExit((e) => {
    e.int("PG_POOL", 20, { min: 1 }); e.url("INVENTORY_URL", "http://localhost:3101");
    e.num("PSP_LATENCY_MS", 100, { min: 0 }); e.num("PSP_FAIL_RATE", 0, { min: 0, max: 1 });
    e.int("PSP_TIMEOUT_MS", 2000, { min: 1 }); e.int("CONFIRM_TIMEOUT_MS", 2000, { min: 1 }); e.bool("PSP_ADMIN", false);
    return { port: e.port("PORT", 3103), broker: e.hostPort("KAFKA_BROKER", "localhost:59092"), shutdown: shutdownEnv(e) };
  });

  const migrationPool = createPool(1, 0); // migrations: no statement timeout (the shared helper also switches it off per connection)
  await migrate(migrationPool);
  await migrationPool.end();

  const kafka = new Kafka({ clientId: "payments", brokers: [cfg.broker] });
  const producer = kafka.producer();
  await producer.connect();
  // Bulkhead: the relay holds a transaction open while it publishes, so it gets its own small pool and cannot starve the saga.
  const relayPool = createPool(3, 5000, "payments-relay");
  registerPoolMetrics(relayPool, "relay");
  const relay = new OutboxRelay(relayPool, (topic, messages) => producer.send({
    topic, acks: -1, timeout: 5000,
    messages: messages.map((m) => ({ key: m.key, value: m.value, headers: m.headers }))
  }).then(() => undefined), 500);
  // Relay loop: drain until empty, then sleep 50 ms; back off 1 s on errors.
  const relayLoop = startLoop({
    name: "outbox-relay", intervalMs: 50, errorDelayMs: 1000, drain: true,
    fn: async () => { const n = await relay.drainOnce(); if (n) outboxPublished.inc(n); return n; },
    onError: (err) => { outboxRelayErrors.inc(); log.warn("outbox relay failed", { err }); }
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: ["error"] });
  const svc = app.get(PaymentsService);
  svc.onSweepError = (id, err) => { sweeperRuns.inc({ result: "error" }); log.warn("sweeper could not advance a saga", { paymentId: id, err }); };
  const sweeperLoop = startLoop({
    name: "sweeper", intervalMs: 1000,
    fn: async () => { const n = await svc.sweep(); sweeperRuns.inc({ result: "ok" }); if (n) sweeperResumed.inc(n); },
    onError: (err) => { sweeperRuns.inc({ result: "error" }); log.warn("sweeper failed", { err }); }
  });

  // Own small pool for readiness and for the gauges that read Postgres at scrape time.
  const healthPool = createPool(2, 5000, "payments-health");
  registerOutboxGauges(healthPool);
  registerSagaGauge(healthPool);
  // Kafka is reported but not critical: the outbox exists so that payments keep working while the broker is down (drill 2).
  const readiness = new Readiness([pgCheck(healthPool), tcpCheck(cfg.broker, "kafka", false)], { cacheMs: 1000 });
  wireNest(app, readiness);

  const shutdown = createShutdown({ ...cfg.shutdown, readiness });
  shutdown.add("http server (stop accepting, drain in-flight)", () => drainHttp(app.getHttpServer(), () => app.close()));
  shutdown.add("sweeper", () => sweeperLoop.stop());
  shutdown.add("outbox relay", () => relayLoop.stop());
  shutdown.add("kafka producer", () => producer.disconnect());
  shutdown.add("postgres pools", async () => { await Promise.all([pool.end(), relayPool.end(), healthPool.end()]); });
  shutdown.install();

  await app.listen({ port: cfg.port, host: "0.0.0.0", backlog: 4096 });
  log.info("listening", { port: cfg.port });
}
bootstrap().catch((e) => { console.error(e); process.exit(1); });
