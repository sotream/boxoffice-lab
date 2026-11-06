import "reflect-metadata";
import Redis from "ioredis";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { verifyAdmission } from "@boxoffice/admission";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMISSION_SECRET, QueueController } from "./queue.controller";
import { QueueService } from "./queue.service";

/** HTTP surface of the waiting room on event 9190 (own range), through a real Nest + Fastify app. */
const E = 9190;
const redis = new Redis("redis://localhost:56379");
const q = new QueueService(redis);
let app: NestFastifyApplication;
class TestModule {}
Module({ controllers: [QueueController], providers: [{ provide: QueueService, useValue: q }] })(TestModule);

beforeAll(async () => {
  await q.reset(E);
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await q.reset(E); await app.close(); await redis.quit(); });

describe("waiting room HTTP", () => {
  it("join -> waiting -> admitted with a verifiable admission token bound to user and event", async () => {
    const join = await app.inject({ method: "POST", url: `/events/${E}/queue/join`, payload: { userId: "alice" } });
    expect(join.json()).toEqual({ position: 1 });
    expect((await app.inject({ method: "GET", url: `/events/${E}/queue/status?userId=alice` })).json()).toMatchObject({ state: "waiting", position: 1 });
    await q.admit(E, 1);
    const st = (await app.inject({ method: "GET", url: `/events/${E}/queue/status?userId=alice` })).json();
    expect(st.state).toBe("admitted");
    expect(verifyAdmission(st.token, E, ADMISSION_SECRET)).toEqual({ userId: "alice" });
    expect(verifyAdmission(st.token, E + 1, ADMISSION_SECRET)).toBeNull();
    expect((await app.inject({ method: "GET", url: `/events/${E}/queue/status?userId=ghost` })).json()).toEqual({ state: "unknown" });
  });

  it("bad input is a 400, never a 5xx", async () => {
    for (const payload of [{}, { userId: "" }, { userId: 5 }, { userId: null }]) {
      expect((await app.inject({ method: "POST", url: `/events/${E}/queue/join`, payload })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: "POST", url: `/events/${E}/queue/join` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/events/${E}/queue/status` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/events/abc/queue/status?userId=a` })).statusCode).toBe(400);
  });
});
