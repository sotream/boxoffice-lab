import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { createPool, migrate, seed } from "./db";

async function bootstrap() {
  const pool = createPool(2);
  await migrate(pool);
  if (process.env.SEED_EVENTS) await seed(pool, Number(process.env.SEED_EVENTS));
  await pool.end();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: ["error"] });
  await app.listen({ port: Number(process.env.PORT ?? 3104), host: "0.0.0.0", backlog: 4096 });
}
bootstrap();
