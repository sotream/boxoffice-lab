import net from "node:net";

/**
 * A small TCP proxy for network faults between two processes of the scenario. Unlike `docker stop`/`pause`, which remove one side
 * cleanly, it leaves both ends alive and changes what is in between:
 *  - `pass`:      forward as is;
 *  - `latency`:   every chunk, in both directions, is delayed by `ms` (order is kept);
 *  - `blackhole`: nothing is forwarded and nothing is closed, like a partition that drops packets: both sides keep their sockets and
 *                 wait. New connections are accepted but their data is held. What was held is delivered, in order, when the mode
 *                 leaves `blackhole` (a short real partition is healed by TCP retransmission in the same way);
 *  - `reset`:     all connections are destroyed now and new ones are destroyed on arrival (a firewall that answers with RST).
 */
export type NetMode = { kind: "pass" } | { kind: "latency"; ms: number } | { kind: "blackhole" } | { kind: "reset" };

interface Pipe { write(chunk: Buffer): void; flush(): void }

export class NetProxy {
  private mode: NetMode = { kind: "pass" };
  private readonly sockets = new Set<net.Socket>();
  private readonly pipes = new Set<Pipe>();
  private server!: net.Server;
  port = 0;
  /** Connections accepted and bytes carried per direction since the start (for assertions that traffic really went through). */
  accepted = 0;
  bytesUp = 0;
  bytesDown = 0;
  /** Connections that had carried data from the target and were then closed (by either end). In a blackhole nothing new becomes established, so a rise there means an old connection was dropped by its owner. */
  closedEstablished = 0;

  private constructor(private readonly targetHost: string, private readonly targetPort: number) {}

  static async start(targetHost: string, targetPort: number): Promise<NetProxy> {
    const p = new NetProxy(targetHost, targetPort);
    p.server = net.createServer((c) => p.onConnection(c));
    await new Promise<void>((res, rej) => { p.server.once("error", rej); p.server.listen(0, "127.0.0.1", res); });
    p.port = (p.server.address() as net.AddressInfo).port;
    return p;
  }

  get current(): NetMode { return this.mode; }

  set(mode: NetMode): void {
    const was = this.mode.kind;
    this.mode = mode;
    if (mode.kind === "reset") { for (const s of this.sockets) s.destroy(); this.sockets.clear(); this.pipes.clear(); return; }
    if (was === "blackhole" && mode.kind !== "blackhole") for (const p of [...this.pipes]) p.flush();
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear(); this.pipes.clear();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private makePipe(to: () => net.Socket | undefined, count: (n: number) => void): Pipe {
    const held: Buffer[] = [];
    let chain: Promise<void> = Promise.resolve();
    let queued = 0; // chunks that went through the delayed chain and are not delivered yet: a direct write must not overtake them
    const deliver = (chunk: Buffer) => { const s = to(); if (s && !s.destroyed) { count(chunk.length); s.write(chunk); } };
    const viaChain = (chunk: Buffer, ms: number) => {
      queued++;
      chain = chain.then(() => new Promise<void>((r) => setTimeout(() => { deliver(chunk); queued--; r(); }, ms)));
    };
    const pipe: Pipe = {
      write: (chunk) => {
        if (this.mode.kind === "blackhole") { held.push(chunk); return; }
        const ms = this.mode.kind === "latency" ? this.mode.ms : 0;
        if (ms === 0 && queued === 0) deliver(chunk); else viaChain(chunk, ms);
      },
      // Everything that was held goes out before anything newer, in the order it arrived.
      flush: () => {
        const ms = this.mode.kind === "latency" ? this.mode.ms : 0;
        const backlog = held.splice(0);
        // without latency the backlog leaves in one write, as a real TCP stack sends what it has queued; one timer per chunk would turn a
        // long partition with many small commands into a slow, artificial trickle (a timer is at least 1 ms)
        if (ms === 0 && queued === 0) { if (backlog.length) deliver(Buffer.concat(backlog)); return; }
        for (const c of backlog) viaChain(c, ms);
      }
    };
    return pipe;
  }

  private onConnection(client: net.Socket): void {
    this.accepted++;
    if (this.mode.kind === "reset") { client.destroy(); return; }
    this.sockets.add(client);
    let upstream: net.Socket | undefined;
    const up = this.makePipe(() => upstream, (n) => { this.bytesUp += n; });
    const down = this.makePipe(() => client, (n) => { this.bytesDown += n; });
    this.pipes.add(up); this.pipes.add(down);
    let established = false, closed = false;
    const closeBoth = () => { if (!closed) { closed = true; if (established) this.closedEstablished++; } client.destroy(); upstream?.destroy(); this.sockets.delete(client); if (upstream) this.sockets.delete(upstream); this.pipes.delete(up); this.pipes.delete(down); };
    client.on("error", closeBoth); client.on("close", closeBoth);
    // Connect to the target right away (also in blackhole: the data is what is held, which is how an established session behaves).
    upstream = net.connect(this.targetPort, this.targetHost);
    this.sockets.add(upstream);
    upstream.on("error", closeBoth); upstream.on("close", closeBoth);
    client.on("data", (c: Buffer) => up.write(c));
    upstream.on("data", (c: Buffer) => { if (this.mode.kind !== "blackhole") established = true; down.write(c); });
  }
}
