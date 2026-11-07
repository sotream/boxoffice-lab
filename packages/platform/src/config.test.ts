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

  it("safeguard: on by default, may be switched off outside production, never in production", () => {
    const f = (env: Record<string, string>) => loadConfig((e) => e.safeguard("VERIFY_HOLDS"), env);
    expect(f({})).toBe(true);
    expect(f({ VERIFY_HOLDS: "1" })).toBe(true);
    expect(f({ VERIFY_HOLDS: "0" })).toBe(false);
    expect(f({ NODE_ENV: "production" })).toBe(true);
    expect(() => f({ NODE_ENV: "production", VERIFY_HOLDS: "0" })).toThrow(/cannot be switched off when NODE_ENV=production/);
    expect(() => f({ VERIFY_HOLDS: "maybe" })).toThrow(/must be a boolean/);
  });

  it("optionalSecret: absent is fine, a known development value is refused only in production", () => {
    const f = (env: Record<string, string>) => loadConfig((e) => e.optionalSecret("PREV", ["dev-internal-token"]), env);
    expect(f({})).toBeUndefined();
    expect(f({ PREV: "old" })).toBe("old");
    expect(f({ PREV: "dev-internal-token" })).toBe("dev-internal-token");
    expect(() => f({ NODE_ENV: "production", PREV: "dev-internal-token" })).toThrow(/known development value/);
    expect(f({ NODE_ENV: "production", PREV: "real-old-key" })).toBe("real-old-key");
  });
});
