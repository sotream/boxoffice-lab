import { Module } from "@nestjs/common";
import Redis from "ioredis";
import { loadConfig } from "@boxoffice/platform";
import { QueueController } from "./queue.controller";
import { QueueService, REDIS } from "./queue.service";

/**
 * Per-command client-side deadline of the queue's Redis client. The gateway waits 8 s for this service, and a silent partition (nothing closed,
 * packets just stop) is never reported by the socket: without a deadline every queue call hangs until the gateway answers 504, and the admission
 * tick stalls on its first command (F14). 1000 ms: a join is four sequential commands that take well under a millisecond each when Redis is healthy,
 * so 1 s is far above any healthy answer (the gateway's limiter uses 200 ms for a single command, but a queue call under a flash-sale load shares
 * the event loop with thousands of others) and far below 8 s. The same deadline bounds the readiness ping and the metrics scrape.
 */
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 1000;
export const redisCommandTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number =>
  loadConfig((e) => e.int("REDIS_COMMAND_TIMEOUT_MS", DEFAULT_REDIS_COMMAND_TIMEOUT_MS, { min: 50, max: 7000 }), env);

@Module({
  controllers: [QueueController],
  providers: [QueueService, { provide: REDIS, useFactory: () => new Redis(process.env.REDIS_URL ?? "redis://localhost:56379", { commandTimeout: redisCommandTimeoutMs() }) }]
})
export class AppModule {}
