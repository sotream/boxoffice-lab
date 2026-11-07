import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { Readiness, signInternalRequest, wireNest } from "@boxoffice/platform";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool, migrate, seed } from "./db";
import { installInternalAuth } from "./internal-auth";
import { InventoryController } from "./inventory.controller";
import { HOLD_TTL, InventoryService, PG } from "./inventory.service";

/**
 * Authentication of inventory's routes through a real Nest + Fastify app with the same hooks main.ts installs, on its own event id (9070).
 * The pool is spied: a rejected request must not even check a connection out, let alone change a seat.
 */
const E = 9070;
const KEY = "inventory-test-key";
const OLD = "inventory-test-previous";
const pool = createPool(5);
const connect = vi.spyOn(pool, "connect");
const query = vi.spyOn(pool, "query");
let app: NestFastifyApplication;
class TestModule {}
Module({ controllers: [InventoryController], providers: [InventoryService, { provide: PG, useValue: pool }, { provide: HOLD_TTL, useValue: 600 }] })(TestModule);

beforeAll(async () => {
  await migrate(pool);
  await seed(pool, E, 12);
  app = await NestFactory.create<NestFastifyApplication>(TestModule, new FastifyAdapter(), { logger: false });
  installInternalAuth(wireNest(app, new Readiness([])), [KEY, OLD]);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => { await pool.query("DELETE FROM seats WHERE event_id=$1", [E]); await app.close(); await pool.end(); });
beforeEach(() => { connect.mockClear(); query.mockClear(); });

const seats = async () => (await pool.query("SELECT seat_id, status, held_by FROM seats WHERE event_id=$1 ORDER BY seat_id", [E])).rows;
const sign = (method: string, path: string, body: string, key = KEY, now = Date.now()) => ({ "x-internal-auth": signInternalRequest(key, method, path, body, now) });
const call = (method: "GET" | "POST", url: string, body: string, headers: Record<string, string>) =>
  app.inject({ method, url, headers: { "content-type": "application/json", ...headers }, payload: method === "GET" ? undefined : body });
const BODY = '{"seatIds":[1,2],"userId":"u"}';
const ROUTES: ["GET" | "POST", string, string][] = [
  ["POST", `/events/${E}/holds`, BODY], ["POST", `/events/${E}/holds/verify`, BODY], ["POST", `/events/${E}/confirm`, BODY], ["GET", `/events/${E}/availability`, ""]
];

describe("inventory requires a signed request on every route", () => {
  it("unsigned requests are 401 on every route and never reach the handler or the database", async () => {
    const before = await seats();
    connect.mockClear(); query.mockClear();
    for (const [m, url, body] of ROUTES) expect((await call(m, url, body, {})).statusCode, `${m} ${url}`).toBe(401);
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(await seats()).toEqual(before);
  });

  it("the check runs before the body is parsed: a malformed body without a signature is 401, not 400", async () => {
    expect((await call("POST", `/events/${E}/holds`, "{not json", {})).statusCode).toBe(401);
    expect((await call("POST", `/events/${E}/confirm`, "{not json", sign("POST", `/events/${E}/confirm`, "{not json"))).statusCode).toBe(400); // signed: the parser's own 400
    expect(connect).not.toHaveBeenCalled();
  });

  it("a captured signature cannot be reused for another body, path, method or key, and it expires; none of them touches the database", async () => {
    const s = sign("POST", `/events/${E}/confirm`, BODY);
    const attempts = await Promise.all([
      call("POST", `/events/${E}/confirm`, '{"seatIds":[1,2],"userId":"thief"}', s),     // other body
      call("POST", `/events/${E}/holds`, BODY, s),                                        // other path
      call("POST", `/events/${E}/confirm`, `${BODY} `, s),                                // one more byte
      call("GET", `/events/${E}/confirm`, "", s),                                         // other method
      call("POST", `/events/${E}/confirm`, BODY, sign("POST", `/events/${E}/confirm`, BODY, "payments-key")),                    // another service's key
      call("POST", `/events/${E}/confirm`, BODY, sign("POST", `/events/${E}/confirm`, BODY, KEY, Date.now() - 60_000)),           // stale
      call("POST", `/events/${E}/confirm`, BODY, sign("POST", `/events/${E}/confirm`, BODY, KEY, Date.now() + 60_000)),           // from the future
      call("POST", `/events/${E}/confirm`, BODY, { "x-internal-auth": KEY }),                                                     // the key itself
      call("POST", `/events/${E}/confirm`, BODY, { "x-internal-token": KEY })
    ]);
    expect(attempts.map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401]);
    expect(connect).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("a body above the cap is refused (413) before it is parsed, even with a valid signature, and never reaches the database", async () => {
    const big = JSON.stringify({ seatIds: [1], userId: "x".repeat(70 * 1024) });
    expect((await call("POST", `/events/${E}/holds`, big, sign("POST", `/events/${E}/holds`, big))).statusCode).toBe(413);
    expect(connect).not.toHaveBeenCalled();
  });

  it("signed requests work end to end: hold, verify, confirm, availability (path signed without the query)", async () => {
    const hold = '{"seatIds":[3,4],"userId":"alice"}';
    const h = await call("POST", `/events/${E}/holds?strategy=for-update`, hold, sign("POST", `/events/${E}/holds`, hold));
    expect(h.statusCode).toBe(201);
    expect((await call("POST", `/events/${E}/holds/verify`, hold, sign("POST", `/events/${E}/holds/verify`, hold))).statusCode).toBe(201);
    expect((await call("POST", `/events/${E}/confirm`, hold, sign("POST", `/events/${E}/confirm`, hold))).statusCode).toBe(201);
    const a = await call("GET", `/events/${E}/availability`, "", sign("GET", `/events/${E}/availability`, ""));
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ sold: 2 });
  });

  it("during a rotation both the current and the previous key are accepted; a third one is not", async () => {
    const url = `/events/${E}/availability`;
    expect((await call("GET", url, "", sign("GET", url, "", OLD))).statusCode).toBe(200);
    expect((await call("GET", url, "", sign("GET", url, "", KEY))).statusCode).toBe(200);
    expect((await call("GET", url, "", sign("GET", url, "", "third"))).statusCode).toBe(401);
  });

  it("/healthz, /readyz and /metrics stay open; an unknown path is denied, not 404", async () => {
    for (const url of ["/healthz", "/readyz", "/metrics"]) expect((await app.inject({ url })).statusCode, url).toBe(200);
    expect((await app.inject({ url: "/nothing-here" })).statusCode).toBe(401);
    expect((await app.inject({ url: `/events/${E}/availability?x=/healthz` })).statusCode).toBe(401);
  });
});
