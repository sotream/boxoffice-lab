import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Readiness } from "./health";
import { startLoop } from "./loop";
import { createShutdown } from "./shutdown";

const setup = (o: Parameters<typeof createShutdown>[0] = {}) => {
  const proc = new EventEmitter() as any;
  const exits: number[] = [];
  const sd = createShutdown({ proc, exit: (c) => { exits.push(c); }, ...o });
  sd.install();
  return { proc, exits, sd };
};

describe("createShutdown", () => {
  it("goes not-ready first, runs steps in order, exits 0", async () => {
    const readiness = new Readiness([]);
    const order: string[] = [];
    const { sd, exits } = setup({ readiness });
    sd.add("server", async () => { order.push(`server draining=${readiness.isDraining}`); });
    sd.add("workers", () => { order.push("workers"); });
    sd.add("pool", async () => { order.push("pool"); });
    expect(await sd.trigger("test")).toBe(0);
    expect(order).toEqual(["server draining=true", "workers", "pool"]);
    expect(exits).toEqual([0]);
  });

  it("waits for a slow drain (in-flight work) before moving on", async () => {
    let drained = false, poolClosedAfterDrain = false;
    const { sd } = setup();
    sd.add("server", () => new Promise<void>((r) => setTimeout(() => { drained = true; r(); }, 60)));
    sd.add("pool", () => { poolClosedAfterDrain = drained; });
    await sd.trigger("t");
    expect(poolClosedAfterDrain).toBe(true);
  });

  it("a failing step does not stop later steps and the exit code is 1", async () => {
    const ran: string[] = [];
    const { sd, exits } = setup();
    sd.add("a", () => { throw new Error("x"); });
    sd.add("b", () => { ran.push("b"); });
    expect(await sd.trigger("t")).toBe(1);
    expect(ran).toEqual(["b"]);
    expect(exits).toEqual([1]);
  });

  it("a step that hangs hits the deadline, later steps still run, exit 1", async () => {
    const ran: string[] = [];
    const { sd } = setup({ deadlineMs: 80 });
    sd.add("hang", () => new Promise(() => undefined));
    sd.add("after", () => { ran.push("after"); });
    const t0 = Date.now();
    expect(await sd.trigger("t")).toBe(1);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(ran).toEqual(["after"]);
  });

  it("SIGTERM triggers once; a second signal forces exit immediately", async () => {
    const { sd, proc, exits } = setup();
    let release!: () => void;
    sd.add("slow", () => new Promise<void>((r) => { release = r; }));
    proc.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 5));
    expect(sd.started).toBe(true);
    proc.emit("SIGINT");
    expect(exits).toEqual([1]); // forced, while the slow step is still running
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(exits).toEqual([1, 0]); // the orderly path still finishes its own exit afterwards in the injected-exit test double
  });

  it("repeated trigger() runs the steps once", async () => {
    let n = 0;
    const { sd } = setup();
    sd.add("a", () => { n++; });
    await Promise.all([sd.trigger("1"), sd.trigger("2")]);
    expect(n).toBe(1);
  });
});

describe("startLoop", () => {
  it("stop() wakes a sleeping loop and waits for the running iteration", async () => {
    let finished = false, started = 0;
    const loop = startLoop({ name: "t", intervalMs: 10_000, fn: async () => { started++; await new Promise((r) => setTimeout(r, 40)); finished = true; } });
    await new Promise((r) => setTimeout(r, 10));
    await loop.stop();
    expect(finished).toBe(true);
    expect(started).toBe(1);
  });

  it("drain mode repeats without sleeping while work is returned, errors back off", async () => {
    let n = 0;
    const errors: unknown[] = [];
    const loop = startLoop({ name: "t", intervalMs: 10_000, drain: true, errorDelayMs: 10_000, onError: (e) => errors.push(e), fn: async () => { n++; if (n === 4) throw new Error("e"); return n < 4 ? 1 : 0; } });
    await new Promise((r) => setTimeout(r, 50));
    await loop.stop();
    expect(n).toBe(4);
    expect(errors).toHaveLength(1);
  });
});

describe("drainHttp", () => {
  it("closes a keep-alive connection that becomes idle after close() started", async () => {
    const { createServer, request, Agent } = await import("node:http");
    const server = createServer((_req, res) => setTimeout(() => res.end("ok"), 80));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const agent = new Agent({ keepAlive: true });
    const got = new Promise<string>((resolve) => request({ port: (server.address() as any).port, host: "127.0.0.1", agent }, (res) => { let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve(b)); }).end());
    await new Promise((r) => setTimeout(r, 20));
    const { drainHttp } = await import("./shutdown");
    const t0 = Date.now();
    await drainHttp(server, () => new Promise<void>((r) => server.close(() => r())));
    expect(await got).toBe("ok");
    expect(Date.now() - t0).toBeLessThan(1500);
    agent.destroy();
  });
});
