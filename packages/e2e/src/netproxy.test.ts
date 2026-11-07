import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NetProxy } from "./netproxy";

let echo: net.Server;
let proxy: NetProxy;
beforeAll(async () => {
  echo = net.createServer((s) => { s.on("data", (d) => s.write(d)); s.on("error", () => undefined); });
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  proxy = await NetProxy.start("127.0.0.1", (echo.address() as net.AddressInfo).port);
});
afterAll(async () => { await proxy.stop(); await new Promise((r) => echo.close(r)); });

const connect = () => new Promise<net.Socket>((res, rej) => { const s = net.connect(proxy.port, "127.0.0.1", () => res(s)); s.on("error", () => undefined); s.once("error", rej); });
const next = (s: net.Socket, ms = 2000) => new Promise<string>((res, rej) => { const t = setTimeout(() => rej(new Error("no data")), ms); s.once("data", (d) => { clearTimeout(t); res(d.toString()); }); });

describe("NetProxy", () => {
  it("passes bytes both ways and counts them", async () => {
    proxy.set({ kind: "pass" });
    const s = await connect();
    s.write("hello");
    expect(await next(s)).toBe("hello");
    expect(proxy.bytesUp).toBeGreaterThanOrEqual(5);
    expect(proxy.bytesDown).toBeGreaterThanOrEqual(5);
    s.destroy();
  });

  it("latency delays each direction (a round trip takes about twice the setting) and keeps the order", async () => {
    proxy.set({ kind: "latency", ms: 120 });
    const s = await connect();
    const t0 = Date.now();
    s.write("a"); s.write("b");
    let got = "";
    while (got.length < 2) got += await next(s);
    const took = Date.now() - t0;
    expect(got).toBe("ab");
    expect(took).toBeGreaterThanOrEqual(220);
    expect(took).toBeLessThan(1500);
    s.destroy();
    proxy.set({ kind: "pass" });
  });

  it("blackhole holds data without closing anything and delivers it in order when healed", async () => {
    proxy.set({ kind: "pass" });
    const s = await connect();
    s.write("x");
    expect(await next(s)).toBe("x");
    proxy.set({ kind: "blackhole" });
    s.write("1"); s.write("2");
    await expect(next(s, 400)).rejects.toThrow("no data");   // nothing comes back, and the socket is still open
    expect(s.destroyed).toBe(false);
    const late = await connect();                             // a new connection is accepted, its data is held too
    late.write("L");
    await expect(next(late, 300)).rejects.toThrow("no data");
    proxy.set({ kind: "pass" });
    let got = "";
    while (got.length < 2) got += await next(s);
    expect(got).toBe("12");
    expect(await next(late)).toBe("L");
    s.destroy(); late.destroy();
  });

  it("a long held backlog is delivered strictly in order, also when new data arrives while it is being released", async () => {
    proxy.set({ kind: "pass" });
    const s = await connect();
    s.write("0"); expect(await next(s)).toBe("0");
    proxy.set({ kind: "blackhole" });
    const expected = Array.from({ length: 60 }, (_, i) => String.fromCharCode(65 + (i % 26)) + i).join("|") + "|";
    for (const part of expected.split("|").filter(Boolean)) s.write(part + "|");
    await new Promise((r) => setTimeout(r, 100));
    proxy.set({ kind: "pass" });
    s.write("END");                                           // newer data right behind the release must not overtake the backlog
    let got = "";
    while (!got.endsWith("END")) got += await next(s);
    expect(got).toBe(expected + "END");
    s.destroy();
  });

  it("reset destroys open connections and new ones on arrival, and pass restores service", async () => {
    proxy.set({ kind: "pass" });
    const s = await connect();
    const closed = new Promise<void>((r) => s.once("close", () => r()));
    proxy.set({ kind: "reset" });
    await closed;
    const fresh = net.connect(proxy.port, "127.0.0.1");
    fresh.on("error", () => undefined);
    await new Promise<void>((r) => fresh.once("close", () => r()));
    proxy.set({ kind: "pass" });
    const ok = await connect();
    ok.write("back");
    expect(await next(ok)).toBe("back");
    ok.destroy();
  });
});
