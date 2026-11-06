import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { Kafka } from "kafkajs";
import { AppModule, pool } from "./app.module";
import { migrate } from "./db";
import { OutboxRelay } from "./outbox-relay";

async function bootstrap() {
  await migrate(pool);
  const kafka = new Kafka({ clientId: "payments", brokers: [process.env.KAFKA_BROKER ?? "localhost:59092"] });
  const producer = kafka.producer();
  await producer.connect();
  const relay = new OutboxRelay(pool, (topic, messages) => producer.send({ topic, messages, acks: -1 }).then(() => undefined), 500);
  // Relay loop: drain until empty, then sleep 50 ms.
  (async () => {
    for (;;) {
      try { if ((await relay.drainOnce()) === 0) await new Promise((r) => setTimeout(r, 50)); }
      catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
  })();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: ["error"] });
  await app.listen({ port: Number(process.env.PORT ?? 3103), host: "0.0.0.0", backlog: 4096 });
}
bootstrap();
