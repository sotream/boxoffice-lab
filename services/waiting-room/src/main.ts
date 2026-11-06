import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";
import { QueueService } from "./queue.service";
import { ADMIT_PER_SECOND } from "./queue.controller";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: ["error"] });
  const q = app.get(QueueService);
  // Admission tick: every 100 ms release a tenth of the per-second budget.
  setInterval(() => { q.admit(1, Math.max(1, Math.round(ADMIT_PER_SECOND / 10))).catch(() => undefined); }, 100);
  await app.listen(Number(process.env.PORT ?? 3102), "0.0.0.0");
}
bootstrap();
