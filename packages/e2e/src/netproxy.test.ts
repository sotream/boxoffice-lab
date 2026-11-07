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

/** A client connection that buffers everything it receives from the moment it is created, so data that arrives while the test is
 *  looking elsewhere is never lost (a once-listener would drop it). */
class Conn {
  received = "";
  closed = false;
  private constructor(readonly sock: net.Socket) {
    sock.on("data", (d) => { this.received += d.toString(); });
    sock.on("close", () => { this.closed = true; });
    sock.on("error", () => undefined);
  }
  static async open(): Promise<Conn> {
    const s = net.connect(proxy.port, "127.0.0.1");
    const c = new Conn(s);
    await new Promise<void>((res, rej) => { s.once("connect", () => res()); s.once("error", rej); });
    return c;
  }
  write(x: string) { this.sock.write(x); }
  async until(pred: (received: string) => boolean, ms = 3000): Promise<string> {
    const end = Date.now() + ms;
    while (!pred(this.received)) { if (Date.now() > end) throw new Error(`no data (have ${JSON.stringify(this.received)})`); await new Promise((r) => setTimeout(r, 10)); }
    return this.received;
  }
  async quiet(ms: number): Promise<boolean> { const n = this.received.length; await new Promise((r) => setTimeout(r, ms)); return this.received.length === n; }
  end() { this.sock.destroy(); }
}

describe("NetProxy", () => {
  it("passes bytes both ways and counts them", async () => {
    proxy.set({ kind: "pass" });
    const c = await Conn.open();
    c.write("hello");
    expect(await c.until((r) => r === "hello")).toBe("hello");
    expect(proxy.bytesUp).toBeGreaterThanOrEqual(5);
    expect(proxy.bytesDown).toBeGreaterThanOrEqual(5);
    c.end();
  });

  it("latency delays each direction (a round trip takes about twice the setting) and keeps the order", async () => {
    proxy.set({ kind: "latency", ms: 120 });
    const c = await Conn.open();
    const t0 = Date.now();
    c.write("a"); c.write("b");
    await c.until((r) => r === "ab");
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(220);
    expect(took).toBeLessThan(2500);
    c.end();
    proxy.set({ kind: "pass" });
  });

  it("blackhole holds data without closing anything and delivers it in order when healed", async () => {
    proxy.set({ kind: "pass" });
    const c = await Conn.open();
    c.write("x");
    await c.until((r) => r === "x");
    proxy.set({ kind: "blackhole" });
    c.write("1"); c.write("2");
    expect(await c.quiet(400)).toBe(true);           // nothing comes back ...
    expect(c.closed).toBe(false);                     // ... and the socket is still open
    const late = await Conn.open();                   // a new connection is accepted, its data is held too
    late.write("L");
    expect(await late.quiet(300)).toBe(true);
    proxy.set({ kind: "pass" });
    expect(await c.until((r) => r === "x12")).toBe("x12");
    expect(await late.until((r) => r === "L")).toBe("L");
    c.end(); late.end();
  });

  it("a long held backlog is delivered strictly in order, also when new data arrives while it is being released", async () => {
    proxy.set({ kind: "pass" });
    const c = await Conn.open();
    c.write("0");
    await c.until((r) => r === "0");
    proxy.set({ kind: "blackhole" });
    const parts = Array.from({ length: 60 }, (_, i) => String.fromCharCode(65 + (i % 26)) + i + "|");
    for (const p of parts) c.write(p);
    await new Promise((r) => setTimeout(r, 100));
    proxy.set({ kind: "pass" });
    c.write("END");                                   // newer data right behind the release must not overtake the backlog
    await c.until((r) => r.endsWith("END"));
    expect(c.received).toBe("0" + parts.join("") + "END");
    c.end();
  });

  it("reset destroys open connections and new ones on arrival, and pass restores service", async () => {
    proxy.set({ kind: "pass" });
    const c = await Conn.open();
    proxy.set({ kind: "reset" });
    await c.until(() => c.closed);
    const fresh = net.connect(proxy.port, "127.0.0.1");
    fresh.on("error", () => undefined);
    await new Promise<void>((r) => fresh.once("close", () => r()));
    proxy.set({ kind: "pass" });
    const ok = await Conn.open();
    ok.write("back");
    expect(await ok.until((r) => r === "back")).toBe("back");
    ok.end();
  });
});
