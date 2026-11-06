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
