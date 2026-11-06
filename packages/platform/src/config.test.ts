import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config";

describe("config", () => {
  it("returns typed values with defaults and keeps existing names", () => {
    const c = loadConfig((e) => ({ port: e.port("PORT", 3100), rate: e.num("IP_RATE", 50), list: e.list("TRUST_PROXY"), f: e.bool("PSP_ADMIN", false) }), {});
    expect(c).toEqual({ port: 3100, rate: 50, list: [], f: false });
  });

  it("treats an empty string as unset", () => {
    expect(loadConfig((e) => e.port("PORT", 7), { PORT: "" })).toBe(7);
  });

  it("reports every problem at once, not just the first", () => {
    let err: ConfigError | undefined;
    try { loadConfig((e) => ({ p: e.port("PORT", 1), n: e.int("PG_POOL", 20, { min: 1 }), b: e.bool("X", false), u: e.url("INVENTORY_URL", "http://a") }), { PORT: "abc", PG_POOL: "0", X: "maybe", INVENTORY_URL: "nope" }); }
    catch (e) { err = e as ConfigError; }
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.problems).toHaveLength(4);
    expect(err!.message).toMatch(/PORT must be an integer, got "abc"/);
    expect(err!.message).toMatch(/PG_POOL must be >= 1/);
  });

  it("rejects non-integers and out-of-range ports", () => {
    expect(() => loadConfig((e) => e.port("PORT", 1), { PORT: "3100.5" })).toThrow(/integer/);
    expect(() => loadConfig((e) => e.port("PORT", 1), { PORT: "70000" })).toThrow(/<= 65535/);
  });

  it("secret: development default is fine outside production, refused in production", () => {
    expect(loadConfig((e) => e.secret("ADMISSION_SECRET", "dev-secret"), {})).toBe("dev-secret");
    expect(() => loadConfig((e) => e.secret("ADMISSION_SECRET", "dev-secret"), { NODE_ENV: "production" })).toThrow(/must be set when NODE_ENV=production/);
    expect(() => loadConfig((e) => e.secret("ADMISSION_SECRET", "dev-secret"), { NODE_ENV: "production", ADMISSION_SECRET: "dev-secret" })).toThrow(/development value/);
    expect(loadConfig((e) => e.secret("ADMISSION_SECRET", "dev-secret"), { NODE_ENV: "production", ADMISSION_SECRET: "real" })).toBe("real");
  });

  it("host:port and oneOf", () => {
    expect(() => loadConfig((e) => e.hostPort("KAFKA_BROKER", "localhost:1"), { KAFKA_BROKER: "localhost" })).toThrow(/host:port/);
    expect(() => loadConfig((e) => e.oneOf("M", ["a", "b"] as const, "a"), { M: "c" })).toThrow(/one of a\|b/);
  });
});
