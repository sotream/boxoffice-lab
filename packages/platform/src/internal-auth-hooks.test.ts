import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { installInternalAuth, internalAuthPolicy, signInternalRequest } from "./internal-auth";

const TOKEN = "unit-test-token";
const OLD = "unit-test-previous";

/** A bare Fastify instance (the one under Nest in the services) with the hooks and handlers that count how often they were reached. */
function build(secrets = [TOKEN]) {
  const app = fastify();
  installInternalAuth(app, internalAuthPolicy(secrets));
  const reached: string[] = [];
  app.post("/things", async (req) => { reached.push(`POST ${req.url}`); return { ok: true, body: req.body }; });
  app.post("/admin/other", async () => { reached.push("POST /admin/other"); return { ok: true }; });
  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async () => ({ status: "ready" }));
  app.get("/metrics", async () => "metrics");
  return { app, reached };
}
const sig = (path: string, body: string, secret = TOKEN, now = Date.now(), method = "POST") => ({ "x-internal-auth": signInternalRequest(secret, method, path, body, now) });
const post = (app: ReturnType<typeof build>["app"], url: string, headers: Record<string, string>, payload = '{"a":1}') =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload });

describe("shared internal authentication hooks (signed requests)", () => {
  it("POST without a signature is 401 and never reaches the handler", async () => {
    const { app, reached } = build();
    expect((await post(app, "/things", {})).statusCode).toBe(401);
    expect(reached).toEqual([]);
  });

  it("the old static header, another header, or a malformed signature is 401", async () => {
    const { app, reached } = build();
    const good = sig("/things", '{"a":1}')["x-internal-auth"];
    for (const h of [{ "x-internal-token": TOKEN }, { authorization: `Bearer ${TOKEN}` }, { "x-internal-auth": TOKEN }, { "x-internal-auth": "" }, { "x-internal-auth": good.toUpperCase() },
      { "x-internal-auth": good.slice(0, -1) }, { "x-internal-auth": `${good}0` }, { "x-internal-auth": `x${good}` }, { "x-internal-auth-2": good }]) {
      expect((await post(app, "/things", h)).statusCode, JSON.stringify(h)).toBe(401);
    }
    expect(reached).toEqual([]);
  });

  it("a signature made with another secret is 401; one made with the right secret passes", async () => {
    const { app, reached } = build();
    expect((await post(app, "/things", sig("/things", '{"a":1}', "other"))).statusCode).toBe(401);
    const res = await post(app, "/things", sig("/things", '{"a":1}'));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, body: { a: 1 } });
    expect(reached).toEqual(["POST /things"]);
  });

  it("a captured signature cannot be reused for another body, path or method, and it expires", async () => {
    const { app, reached } = build();
    const s = sig("/things", '{"a":1}');
    expect((await post(app, "/things", s, '{"a":2}')).statusCode).toBe(401);          // other body
    expect((await post(app, "/things", s, '{"a":1} ')).statusCode).toBe(401);         // one more byte
    expect((await post(app, "/admin/other", s)).statusCode).toBe(401);                     // other path
    expect((await app.inject({ method: "PUT", url: "/things", headers: { "content-type": "application/json", ...s }, payload: '{"a":1}' })).statusCode).toBe(401); // other method
    expect((await post(app, "/things", sig("/things", '{"a":1}', TOKEN, Date.now() - 60_000))).statusCode).toBe(401); // too old
    expect((await post(app, "/things", sig("/things", '{"a":1}', TOKEN, Date.now() + 60_000))).statusCode).toBe(401); // too far in the future
    expect(reached).toEqual([]);
    expect((await post(app, "/things", sig("/things", '{"a":1}', TOKEN, Date.now() - 20_000))).statusCode).toBe(200); // inside the skew
  });

  it("the check runs before the body is parsed: a malformed body without a signature is 401, not 400", async () => {
    const { app, reached } = build();
    expect((await post(app, "/things", {}, "{not json")).statusCode).toBe(401);
    // signed, the same body is a parse error (400): proves the 401 above came from the hooks, not from the parser
    expect((await post(app, "/things", sig("/things", "{not json"), "{not json")).statusCode).toBe(400);
    expect(reached).toEqual([]);
  });

  it("a body above the cap is refused (413) before it is parsed, even with a valid-looking header", async () => {
    const { app, reached } = build();
    const big = JSON.stringify({ pad: "x".repeat(70 * 1024) });
    expect((await post(app, "/things", sig("/things", big), big)).statusCode).toBe(413);
    expect(reached).toEqual([]);
  });

  it("during a rotation both the current and the previous secret are accepted; a third one is not", async () => {
    const { app, reached } = build([TOKEN, OLD]);
    expect((await post(app, "/things", sig("/things", '{"a":1}', OLD))).statusCode).toBe(200);
    expect((await post(app, "/things", sig("/things", '{"a":1}', TOKEN))).statusCode).toBe(200);
    expect((await post(app, "/things", sig("/things", '{"a":1}', "third"))).statusCode).toBe(401);
    expect(reached).toEqual(["POST /things", "POST /things"]);
    const only = build([TOKEN]);
    expect((await post(only.app, "/things", sig("/things", '{"a":1}', OLD))).statusCode).toBe(401);
  });

  it("every other route needs a signature too", async () => {
    const { app, reached } = build();
    expect((await post(app, "/admin/other", {})).statusCode).toBe(401);
    expect((await post(app, "/admin/other", sig("/admin/other", '{"a":1}'))).statusCode).toBe(200);
    expect(reached).toEqual(["POST /admin/other"]);
  });

  it("the hooks enforce the policy they are given: its verifier and its body cap", async () => {
    const app = fastify();
    installInternalAuth(app, { verify: (_h, method, path, body) => method === "POST" && path === "/things" && body.toString() === "{\"a\":1}", maxBodyBytes: 10 });
    app.post("/things", async () => ({ ok: true }));
    const fresh = sig("/things", "unrelated to the verifier");
    expect((await post(app, "/things", fresh)).statusCode).toBe(200);   // the policy's verifier decides, not the header's content
    expect((await post(app, "/things", fresh, '{"a":2}')).statusCode).toBe(401);
    expect((await post(app, "/things", fresh, '{"a":1,"b":2}')).statusCode).toBe(413); // above its cap of 10 bytes
  });

  it("the signature covers the path without the query string", async () => {
    const { app, reached } = build();
    expect((await post(app, "/things?x=1", sig("/things", '{"a":1}'))).statusCode).toBe(200);
    expect(reached).toEqual(["POST /things?x=1"]);
  });

  it("/healthz, /readyz and /metrics stay open without a signature", async () => {
    const { app } = build();
    for (const url of ["/healthz", "/readyz", "/metrics", "/healthz?x=1"]) expect((await app.inject({ url })).statusCode, url).toBe(200);
  });

  it("deny by default: only the exact probe paths are open (no prefix, query or case trick)", async () => {
    const { app, reached } = build();
    for (const url of ["/healthz/x", "/things?x=/healthz", "/things?/metrics", "/HEALTHZ", "//healthz", "/metrics/", "/unknown"]) {
      expect((await post(app, url, {})).statusCode, url).toBe(401);
    }
    expect(reached).toEqual([]);
  });
});
