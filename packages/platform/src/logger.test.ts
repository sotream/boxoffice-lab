import { describe, expect, it } from "vitest";
import { contextFromHeaders, runWithContext } from "./context";
import { createLogger, defaultLevel } from "./logger";

const capture = () => { const lines: Record<string, any>[] = []; return { lines, write: (l: string) => lines.push(JSON.parse(l)) }; };

describe("logger", () => {
  it("writes one JSON object per line with level, service, message and fields", () => {
    const c = capture();
    createLogger({ service: "svc", level: "info", write: c.write }).info("hello", { a: 1 });
    expect(c.lines[0]).toMatchObject({ level: "info", service: "svc", msg: "hello", a: 1 });
    expect(typeof c.lines[0].time).toBe("string");
  });

  it("filters below the level", () => {
    const c = capture();
    const l = createLogger({ service: "s", level: "warn", write: c.write });
    l.debug("d"); l.info("i"); l.warn("w"); l.error("e");
    expect(c.lines.map((x) => x.level)).toEqual(["warn", "error"]);
  });

  it("serializes errors with type, message, stack, code and cause", () => {
    const c = capture();
    const e = Object.assign(new TypeError("boom", { cause: new Error("root") }), { code: "E1" });
    createLogger({ service: "s", level: "info", write: c.write }).error("failed", { err: e });
    expect(c.lines[0].err).toMatchObject({ type: "TypeError", message: "boom", code: "E1", cause: { message: "root" } });
    expect(c.lines[0].err.stack).toContain("boom");
  });

  it("adds request and trace ids from the async context and from child()", () => {
    const c = capture();
    const l = createLogger({ service: "s", level: "info", write: c.write }).child({ component: "relay" });
    const ctx = contextFromHeaders({ "x-request-id": "r9" });
    runWithContext(ctx, () => l.info("in request"));
    l.info("outside");
    expect(c.lines[0]).toMatchObject({ requestId: "r9", traceId: ctx.traceId, spanId: ctx.spanId, component: "relay" });
    expect(c.lines[1].requestId).toBeUndefined();
  });

  it("does not throw on circular fields", () => {
    const c = capture();
    const o: any = {}; o.self = o;
    createLogger({ service: "s", level: "info", write: c.write }).info("x", { o });
    expect(c.lines[0].logError).toBeDefined();
  });

  it("is silent by default under test, LOG_LEVEL overrides", () => {
    expect(defaultLevel({ VITEST: "true" })).toBe("silent");
    expect(defaultLevel({ NODE_ENV: "test" })).toBe("silent");
    expect(defaultLevel({})).toBe("info");
    expect(defaultLevel({ NODE_ENV: "test", LOG_LEVEL: "debug" })).toBe("debug");
  });
});
