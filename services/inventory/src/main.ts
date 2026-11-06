import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { createPool, migrate, seed } from "./db";

async function bootstrap() {
  const pool = createPool(2);
  await migrate(pool);
  if (process.env.SEED_SEATS) await seed(pool, 1, Number(process.env.SEED_SEATS));
  await pool.end();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: ["error"] });
  await app.listen(Number(process.env.PORT ?? 3101), "0.0.0.0");
}
bootstrap();
