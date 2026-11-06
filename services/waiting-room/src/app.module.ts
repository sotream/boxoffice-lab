import { Module } from "@nestjs/common";
import Redis from "ioredis";
import { QueueController } from "./queue.controller";
import { QueueService, REDIS } from "./queue.service";

@Module({
  controllers: [QueueController],
  providers: [QueueService, { provide: REDIS, useFactory: () => new Redis(process.env.REDIS_URL ?? "redis://localhost:56379") }]
})
export class AppModule {}
