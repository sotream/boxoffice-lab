import { FastifyAdapter } from "@nestjs/platform-fastify";
import { describe, expect, it } from "vitest";
import { installInternalAuth, tokenMatches } from "./internal-auth";

const TOKEN = "unit-test-token";

describe("tokenMatches (constant-time comparison)", () => {
  it("accepts only the exact token", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    for (const bad of ["", "unit-test-toke", "unit-test-token ", "UNIT-TEST-TOKEN", "unit-test-token-and-more", undefined, null, 42, ["unit-test-token"]]) {
      expect(tokenMatches(bad, TOKEN), String(bad)).toBe(false);
    }
  });
  it("never throws on tokens of a different length (hashes have equal length)", () => {
    expect(() => tokenMatches("x".repeat(10_000), TOKEN)).not.toThrow();
  });
});

/** A bare Fastify instance (the one under Nest) with the hook and a handler that counts how often it was reached. */
function build() {
  const app = new FastifyAdapter().getInstance();
  installInternalAuth(app, TOKEN);
  const reached: string[] = [];
  app.post("/payments", async (req) => { reached.push(`POST ${req.url}`); return { ok: true, body: req.body }; });
  app.post("/admin/psp", async () => { reached.push("POST /admin/psp"); return { ok: true }; });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));
  app.get("/metrics", async () => "metrics");
  return { app, reached };
}
const post = (app: ReturnType<typeof build>["app"], url: string, headers: Record<string, string>, payload = '{"a":1}') =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload });

describe("internal authentication hook", () => {
  it("POST /payments without the token is 401 and never reaches the handler", async () => {
    const { app, reached } = build();
    const res = await post(app, "/payments", {});
    expect(res.statusCode).toBe(401);
    expect(reached).toEqual([]);
  });

  it("a wrong token (also: same length, prefix, other header, empty) is 401", async () => {
    const { app, reached } = build();
    for (const h of [{ "x-internal-token": "unit-test-tokeX" }, { "x-internal-token": "unit-test" }, { "x-internal-token": "" }, { authorization: `Bearer ${TOKEN}` }, { "x-internal-token-2": TOKEN }]) {
      expect((await post(app, "/payments", h)).statusCode, JSON.stringify(h)).toBe(401);
    }
    expect(reached).toEqual([]);
  });

  it("the check runs before the body is parsed: a malformed body without the token is 401, not 400", async () => {
    const { app, reached } = build();
    expect((await post(app, "/payments", {}, "{not json")).statusCode).toBe(401);
    // with the token the same body is a parse error (400): proves the 401 above came from the hook, not from the parser
    expect((await post(app, "/payments", { "x-internal-token": TOKEN }, "{not json")).statusCode).toBe(400);
    expect(reached).toEqual([]);
  });

  it("the right token passes through to the handler", async () => {
    const { app, reached } = build();
    const res = await post(app, "/payments", { "x-internal-token": TOKEN });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, body: { a: 1 } });
    expect(reached).toEqual(["POST /payments"]);
  });

  it("the admin endpoint needs the token too", async () => {
    const { app, reached } = build();
    expect((await post(app, "/admin/psp", {})).statusCode).toBe(401);
    expect((await post(app, "/admin/psp", { "x-internal-token": TOKEN })).statusCode).toBe(200);
    expect(reached).toEqual(["POST /admin/psp"]);
  });

  it("/healthz, /readyz and /metrics stay open without the token", async () => {
    const { app } = build();
    for (const url of ["/healthz", "/readyz", "/metrics", "/healthz?x=1"]) expect((await app.inject({ url })).statusCode, url).toBe(200);
  });

  it("deny by default: only the exact probe paths are open (no prefix, query or case trick)", async () => {
    const { app, reached } = build();
    for (const url of ["/healthz/x", "/payments?x=/healthz", "/payments?/metrics", "/HEALTHZ", "//healthz", "/metrics/", "/unknown"]) {
      expect((await post(app, url, {})).statusCode, url).toBe(401);
    }
    expect(reached).toEqual([]);
  });
});
