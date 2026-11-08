import "reflect-metadata";
import net from "node:net";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import Redis from "ioredis";
import { ConfigError, startLoop } from "@boxoffice/platform";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_REDIS_COMMAND_TIMEOUT_MS, redisCommandTimeoutMs } from "./app.module";
import { QueueController } from "./queue.controller";
import { QueueService } from "./queue.service";
import { isRedisUnavailable } from "./redis-unavailable";

/** Redis database 12 (own range: the other tests of this package use 0, the e2e stack takes an empty one of 11 to 15 and checks it is empty). */
const REDIS_HOST = "127.0.0.1", REDIS_PORT = 56379, DB = 12;
const E = 9191;

/** A TCP relay to Redis that can go silent: the connection stays open on both sides, bytes sent while silent are held and delivered on heal (like a real partition that heals). */
class Relay {
  silent = false;
  private held: (() => void)[] = [];
  private readonly sockets = new Set<net.Socket>();
  private readonly server = net.createServer((c) => {
    const up = net.connect(REDIS_PORT, REDIS_HOST);
    this.sockets.add(c); this.sockets.add(up);
    c.on("data", (d) => { if (this.silent) this.held.push(() => up.write(d)); else up.write(d); });
    up.on("data", (d) => { if (this.silent) this.held.push(() => c.write(d)); else c.write(d); });
    for (const s of [c, up]) { s.on("error", () => undefined); s.on("close", () => { this.sockets.delete(s); c.destroy(); up.destroy(); }); }
  });
  port = 0;
  async start() { await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r)); this.port = (this.server.address() as net.AddressInfo).port; return this; }
  heal() { this.silent = false; const h = this.held; this.held = []; for (const f of h) f(); }
  async stop() { for (const s of this.sockets) s.destroy(); await new Promise((r) => this.server.close(r)); }
}

const relay = new Relay();
const clients: Redis[] = [];
const client = (port: number, commandTimeout: number) => { const r = new Redis({ host: "127.0.0.1", port, db: DB, commandTimeout }); r.on("error", () => undefined); clients.push(r); return r; };
beforeAll(async () => { await relay.start(); });
afterEach(async () => { relay.heal(); const direct = client(REDIS_PORT, 2000); await new QueueService(direct).reset(E); });
afterAll(async () => { for (const c of clients) c.disconnect(); await relay.stop(); });

const took = async (p: Promise<unknown>) => { const t0 = Date.now(); const r = await p.then(() => "ok", (e: Error) => e); return { r, ms: Date.now() - t0 }; };

describe("REDIS_COMMAND_TIMEOUT_MS", () => {
  it("defaults to 1000 ms, accepts a value in range and rejects anything else with a ConfigError", () => {
    expect(DEFAULT_REDIS_COMMAND_TIMEOUT_MS).toBe(1000);
    expect(redisCommandTimeoutMs({})).toBe(1000);
    expect(redisCommandTimeoutMs({ REDIS_COMMAND_TIMEOUT_MS: "250" })).toBe(250);
    for (const bad of ["abc", "49", "0", "7001", "-5", "1.5"]) expect(() => redisCommandTimeoutMs({ REDIS_COMMAND_TIMEOUT_MS: bad }), bad).toThrow(ConfigError);
  });
});

describe("a silent Redis path (connection open, nothing answers)", () => {
  it("a queue call rejects after the command timeout, not after the path heals, and the error is recognised as 'Redis unavailable'", async () => {
    const q = new QueueService(client(relay.port, 200));
    expect((await q.join(E, "warm")).position).toBe(1); // healthy through the relay
    relay.silent = true;
    const { r, ms } = await took(q.join(E, "u1"));
    expect(r).toBeInstanceOf(Error);
    expect(isRedisUnavailable(r)).toBe(true);
    expect(ms).toBeGreaterThanOrEqual(150);
    expect(ms).toBeLessThan(2_000);
    const st = await took(q.status(E, "warm", 10));
    expect(isRedisUnavailable(st.r)).toBe(true);
    expect(st.ms).toBeLessThan(2_000);
  });

  it("without a command timeout the same call waits for the heal (the behaviour F14 measured before the fix)", async () => {
    const r = new Redis({ host: "127.0.0.1", port: relay.port, db: DB }); r.on("error", () => undefined); clients.push(r);
    const q = new QueueService(r);
    await q.join(E, "warm");
    relay.silent = true;
    let settled = false;
    const call = q.length(E).then((n) => { settled = true; return n; });
    await new Promise((res) => setTimeout(res, 600));
    expect(settled).toBe(false);
    relay.heal();
    expect(await call).toBe(1);
  });

  it("a join that timed out changed nothing (it stops at its first command), so a retry after the heal lands once at the back; the client needs no reconnect", async () => {
    const q = new QueueService(client(relay.port, 150));
    await q.join(E, "a");
    relay.silent = true;
    expect(isRedisUnavailable((await took(q.join(E, "b"))).r)).toBe(true);
    relay.heal();
    await new Promise((res) => setTimeout(res, 200));
    expect(await q.length(E), "only the late read of the timed-out join ran").toBe(1);
    expect((await q.join(E, "b")).position).toBe(2);
    expect((await q.join(E, "b")).position).toBe(2);
    expect(await q.length(E)).toBe(2);
  });

  it("why the admission tick has no command timeout: a ZPOPMIN that timed out on the client is still executed at the heal and its users are popped without an admission key", async () => {
    const withDeadline = new QueueService(client(relay.port, 100));
    await withDeadline.join(E, "x"); await withDeadline.join(E, "y");
    relay.silent = true;
    expect(isRedisUnavailable((await took(withDeadline.admit(E, 2))).r)).toBe(true);
    relay.heal();
    await new Promise((res) => setTimeout(res, 300));
    const direct = new QueueService(client(REDIS_PORT, 2000));
    expect(await direct.length(E), "Redis executed the held ZPOPMIN").toBe(0);
    expect(await direct.isAdmitted(E, "x"), "nobody ever wrote the key").toBe(false);
    expect(await direct.status(E, "x", 10)).toEqual({ state: "unknown" });
  });

  it("a tick on a client without a deadline stalls on its one in-flight command during the partition (no pile-up, no lost users) and completes the admission at the heal", async () => {
    const r = new Redis({ host: "127.0.0.1", port: relay.port, db: DB }); r.on("error", () => undefined); clients.push(r);
    const q = new QueueService(r);
    await q.join(E, "x"); await q.join(E, "y");
    relay.silent = true;
    let calls = 0, errors = 0;
    const tick = startLoop({ name: "admission-test", intervalMs: 20, fn: () => { calls++; return q.admit(E, 2).then(() => undefined); }, onError: () => { errors++; } });
    await new Promise((res) => setTimeout(res, 700));
    expect(calls, "one iteration at a time: a hanging command cannot make ticks pile up").toBe(1);
    relay.heal();
    await new Promise((res) => setTimeout(res, 400));
    await tick.stop();
    const direct = new QueueService(client(REDIS_PORT, 2000));
    expect(errors).toBe(0);
    expect(await direct.isAdmitted(E, "x")).toBe(true);
    expect(await direct.isAdmitted(E, "y")).toBe(true);
    expect(await direct.length(E)).toBe(0);
  });
});

describe("HTTP mapping of an unavailable Redis", () => {
  let app: NestFastifyApplication;
  const failing = { join: async () => { throw new TypeError("a bug, not Redis"); }, status: async () => { throw new TypeError("a bug, not Redis"); } };
  let q: QueueService | typeof failing;
  class TestModule {}
  Module({ controllers: [QueueController], providers: [{ provide: QueueService, useFactory: () => q }] })(TestModule);
  const boot = async (service: QueueService | typeof failing) => {
    q = service;
    app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), { logger: false });
    await app.init(); await app.getHttpAdapter().getInstance().ready();
  };
  afterEach(async () => { await app?.close(); });

  it("join and status answer 503 with Retry-After: 1 within the command timeout while Redis is silent; bad input is still 400", async () => {
    await boot(new QueueService(client(relay.port, 200)));
    relay.silent = true;
    for (const req of [
      { method: "POST", url: `/events/${E}/queue/join`, payload: { userId: "alice" } },
      { method: "GET", url: `/events/${E}/queue/status?userId=alice` }
    ] as const) {
      const t0 = Date.now();
      const res = await app.inject(req);
      expect(res.statusCode, req.url).toBe(503);
      expect(res.headers["retry-after"]).toBe("1");
      expect(res.json()).toMatchObject({ statusCode: 503 });
      expect(Date.now() - t0).toBeLessThan(2_000);
    }
    expect((await app.inject({ method: "POST", url: `/events/${E}/queue/join`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/events/${E}/queue/status` })).statusCode).toBe(400);
    relay.heal();
    await new Promise((res) => setTimeout(res, 100));
    expect((await app.inject({ method: "POST", url: `/events/${E}/queue/join`, payload: { userId: "alice" } })).statusCode).toBe(201);
  });

  it("a stopped Redis (connection refused) is a bounded 503 too", async () => {
    const dead = net.createServer(); await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as net.AddressInfo).port; await new Promise((r) => dead.close(r));
    await boot(new QueueService(client(port, 200)));
    const t0 = Date.now();
    const res = await app.inject({ method: "POST", url: `/events/${E}/queue/join`, payload: { userId: "alice" } });
    expect(res.statusCode).toBe(503);
    expect(res.headers["retry-after"]).toBe("1");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it("an error that is not about Redis stays a 500 without Retry-After (a bug is not retried as if it were an outage)", async () => {
    await boot(failing as unknown as QueueService);
    const res = await app.inject({ method: "POST", url: `/events/${E}/queue/join`, payload: { userId: "alice" } });
    expect(res.statusCode).toBe(500);
    expect(res.headers["retry-after"]).toBeUndefined();
  });
});

describe("isRedisUnavailable", () => {
  it("recognises what ioredis throws when the store cannot answer, and nothing else", () => {
    for (const m of ["Command timed out", "Connection is closed.", "connect ECONNREFUSED 127.0.0.1:1", "read ECONNRESET", "LOADING Redis is loading the dataset in memory"]) expect(isRedisUnavailable(new Error(m)), m).toBe(true);
    expect(isRedisUnavailable(Object.assign(new Error("Reached the max retries per request limit (which is 20)."), { name: "MaxRetriesPerRequestError" }))).toBe(true);
    for (const e of [new TypeError("x is not a function"), new Error("WRONGTYPE Operation against a key"), "Command timed out", undefined]) expect(isRedisUnavailable(e)).toBe(false);
  });
});
