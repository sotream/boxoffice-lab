import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

const seen: string[] = [];
const svc = { handle: async (_m: string, _p: string, _q: string, _b: string | undefined, ip: string) => { seen.push(ip); return { status: 200, body: "{}" }; } };
const call = (app: ReturnType<typeof buildApp>) =>
  app.inject({ method: "GET", url: "/events/1/availability", remoteAddress: "10.0.0.9", headers: { "x-forwarded-for": "6.6.6.6" } });

describe("client IP used as the rate-limit key", () => {
  it("ignores a spoofed x-forwarded-for by default", async () => {
    seen.length = 0;
    await call(buildApp(svc));
    expect(seen).toEqual(["10.0.0.9"]);
  });

  it("honours x-forwarded-for only from a trusted proxy address", async () => {
    seen.length = 0;
    await call(buildApp(svc, ["10.0.0.0/8"]));
    expect(seen).toEqual(["6.6.6.6"]);
  });

  it("does not honour it from an untrusted peer even when a proxy list is set", async () => {
    seen.length = 0;
    await call(buildApp(svc, ["192.168.0.0/16"]));
    expect(seen).toEqual(["10.0.0.9"]);
  });
});

describe("headers handed to the service", () => {
  it("passes the Idempotency-Key header (and only the first value of the admission header) to GatewayService.handle", async () => {
    const got: (string | undefined)[][] = [];
    const app = buildApp({ handle: async (_m, _p, _q, _b, _ip, admission, _fwd, key) => { got.push([admission, key]); return { status: 200, body: "{}" }; } });
    await app.inject({ method: "POST", url: "/events/1/pay", headers: { "x-admission": "tok", "idempotency-key": "k-1", "content-type": "application/json" }, payload: "{}" });
    await app.inject({ method: "POST", url: "/events/1/pay", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(got).toEqual([["tok", "k-1"], [undefined, undefined]]);
  });
});
