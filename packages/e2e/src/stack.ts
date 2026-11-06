import { join } from "node:path";
import Redis from "ioredis";
import { Pool } from "pg";
import { createScratchDatabase, ensureBuilt, freePort, RunningService, spawnService, waitHealthy, waitUntil } from "@boxoffice/platform";
import { Bridge, BROKER } from "./bridge";

const ROOT = join(__dirname, "..", "..", "..");
export const SECRET = "e2e-secret";
export type Name = "inventory" | "waiting-room" | "gateway" | "payments" | "notifications";
const DIR: Record<Name, string> = { inventory: "services/inventory", "waiting-room": "services/waiting-room", gateway: "services/gateway", payments: "services/payments", notifications: "services/notifications" };

export interface StackOptions {
  tag: string;
  seats: number;
  admitPerSecond?: number;
  pspLatencyMs?: number;
  pspFailRate?: number;
  /** Extra env for the main gateway. */
  gatewayEnv?: Record<string, string>;
  /** LOG_LEVEL=debug for gateway, inventory and payments, so request ids can be found in their logs. */
  debugLogs?: boolean;
  /** Fraction of events the bridge delivers twice (default 0.2). */
  duplicateRate?: number;
  seed?: number;
}

const live = new Set<RunningService>();
process.on("exit", () => { for (const s of live) { try { s.child.kill("SIGKILL"); } catch { /* gone */ } } });

/**
 * One private world: scratch Postgres database, a free Redis logical DB, private Kafka topic and consumer group, free ports.
 * Real built services run as child processes; nothing is mocked. A service can be killed with SIGKILL and started again on the same port.
 */
export class Stack {
  readonly ports = {} as Record<Name | "ops" | "gatewayOps", number>;
  readonly urls = {} as Record<Name, string>;
  readonly procs = new Map<Name | string, RunningService>();
  /** Output of every incarnation of every process, oldest first (a killed process keeps its log). */
  readonly logs = new Map<string, string[]>();
  private readonly envs = new Map<string, Record<string, string>>();
  pool!: Pool;
  bridge!: Bridge;
  scratch!: Awaited<ReturnType<typeof createScratchDatabase>>;
  redisDb = -1;
  redisUrl = "";
  runId = "";
  userPrefix = "";
  private redis!: Redis;
  private groupId = "";
  private opts!: StackOptions;

  static async start(opts: StackOptions): Promise<Stack> {
    const s = new Stack();
    try { await s.init(opts); } catch (e) { await s.stop(); throw e; }
    return s;
  }

  private async init(opts: StackOptions) {
    this.opts = opts;
    for (const n of Object.keys(DIR) as Name[]) ensureBuilt(join(ROOT, DIR[n]));
    this.runId = `${opts.tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    this.userPrefix = `u-${this.runId}-`;
    this.groupId = `e2e-${this.runId}-notifications`;

    this.scratch = await createScratchDatabase(`e2e_${opts.tag}`);
    this.pool = new Pool({ connectionString: this.scratch.url, max: 4 });

    // A private Redis logical DB: the first of 11..15 that is empty. We never flush anything, we only delete our own keys at the end.
    for (const db of [11, 12, 13, 14, 15]) {
      const r = new Redis(`redis://localhost:56379/${db}`, { lazyConnect: true, maxRetriesPerRequest: 1 });
      await r.connect();
      if ((await r.dbsize()) === 0) { this.redis = r; this.redisDb = db; break; }
      r.disconnect();
    }
    if (this.redisDb < 0) throw new Error("no empty Redis logical DB among 11..15");
    this.redisUrl = `redis://localhost:56379/${this.redisDb}`;

    for (const k of ["inventory", "waiting-room", "gateway", "payments", "notifications", "ops", "gatewayOps"] as const) this.ports[k] = await freePort();
    for (const n of ["inventory", "waiting-room", "gateway", "payments"] as Name[]) this.urls[n] = `http://127.0.0.1:${this.ports[n]}`;

    this.bridge = await Bridge.start(this.runId, this.userPrefix, opts.duplicateRate ?? 0.2, opts.seed ?? 1);

    const dbg: Record<string, string> = opts.debugLogs ? { LOG_LEVEL: "debug" } : {};
    const db = { DATABASE_URL: this.scratch.url };
    this.envs.set("inventory", { PORT: String(this.ports.inventory), SEED_SEATS: String(opts.seats), ...db, ...dbg });
    this.envs.set("waiting-room", { PORT: String(this.ports["waiting-room"]), REDIS_URL: this.redisUrl, ADMISSION_SECRET: SECRET, ADMIT_PER_SECOND: String(opts.admitPerSecond ?? 300) });
    this.envs.set("gateway", {
      PORT: String(this.ports.gateway), OPS_PORT: String(this.ports.gatewayOps), REDIS_URL: this.redisUrl, INVENTORY_URL: this.urls.inventory, QUEUE_URL: this.urls["waiting-room"],
      ADMISSION_SECRET: SECRET, IP_RATE: "100000", IP_BURST: "100000", USER_RATE: "1000", USER_BURST: "1000", UPSTREAM_TIMEOUT_MS: "8000", ...dbg, ...opts.gatewayEnv
    });
    this.envs.set("payments", {
      PORT: String(this.ports.payments), INVENTORY_URL: this.urls.inventory, KAFKA_BROKER: BROKER, ...db,
      PSP_LATENCY_MS: String(opts.pspLatencyMs ?? 50), PSP_FAIL_RATE: String(opts.pspFailRate ?? 0), ...dbg
    });
    this.envs.set("notifications", {
      OPS_PORT: String(this.ports.ops), KAFKA_BROKER: BROKER, TOPIC: this.bridge.topic, GROUP_ID: this.groupId, SENDER_LATENCY_MS: "5", CONCURRENCY: "25", ...db
    });

    // Inventory first: it creates the seats table and seeds, and payments needs it only at runtime.
    await this.start("inventory");
    await Promise.all([this.start("waiting-room"), this.start("payments"), this.start("notifications")]);
    await this.start("gateway");
  }

  async start(name: Name): Promise<void> {
    const svc = spawnService(join(ROOT, DIR[name]), this.envs.get(name)!);
    live.add(svc);
    this.procs.set(name, svc);
    (this.logs.get(name) ?? this.logs.set(name, []).get(name)!).push("");
    const idx = this.logs.get(name)!.length - 1;
    const sync = setInterval(() => { this.logs.get(name)![idx] = svc.output(); }, 250);
    void svc.exited.then(() => { clearInterval(sync); this.logs.get(name)![idx] = svc.output(); live.delete(svc); });
    const base = name === "notifications" ? `http://127.0.0.1:${this.ports.ops}` : name === "gateway" ? `http://127.0.0.1:${this.ports.gatewayOps}` : this.urls[name];
    try { await waitHealthy(base, "/healthz", 30_000); }
    catch (e) { throw new Error(`${name} did not become healthy: ${(e as Error).message}\n${svc.output().slice(-3000)}`); }
  }

  /** An additional gateway (other limits, or a dead Redis) on its own port. Killed with the stack. */
  async startGateway(label: string, env: Record<string, string>): Promise<string> {
    const port = await freePort();
    const opsPort = await freePort();
    this.envs.set(label, { ...this.envs.get("gateway")!, PORT: String(port), OPS_PORT: String(opsPort), ...env });
    const svc = spawnService(join(ROOT, DIR.gateway), this.envs.get(label)!);
    live.add(svc);
    this.procs.set(label, svc);
    void svc.exited.then(() => live.delete(svc));
    await waitHealthy(`http://127.0.0.1:${opsPort}`, "/healthz", 30_000);
    return `http://127.0.0.1:${port}`;
  }

  async kill(name: string): Promise<void> {
    const svc = this.procs.get(name);
    if (!svc) return;
    svc.child.kill("SIGKILL");
    await svc.exited;
  }

  /** Concatenated logs of all incarnations of a process. */
  log(name: string): string { return (this.logs.get(name) ?? []).join("\n"); }

  /** Sum of a Prometheus counter over all label sets, from a live process; undefined if it cannot be scraped. */
  async counter(url: string, metric: string): Promise<number | undefined> {
    try {
      const text = await (await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(2000) })).text();
      let sum = 0; let found = false;
      for (const line of text.split("\n")) if (line.startsWith(metric) && !line.startsWith("#")) { sum += Number(line.split(" ").pop()); found = true; }
      return found ? sum : 0;
    } catch { return undefined; }
  }
  get opsUrl() { return `http://127.0.0.1:${this.ports.ops}`; }

  async q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> { return (await this.pool.query(sql, params)).rows as T[]; }
  waitUntil = waitUntil;

  async stop(): Promise<void> {
    // The consumer leaves its group cleanly (SIGTERM) so the private group can be deleted; everything else just dies.
    const notif = this.procs.get("notifications");
    if (notif && notif.child.exitCode === null && notif.child.signalCode === null) {
      notif.child.kill("SIGTERM");
      await Promise.race([notif.exited, new Promise((r) => setTimeout(r, 6000))]);
    }
    for (const [, s] of this.procs) { try { s.child.kill("SIGKILL"); } catch { /* gone */ } }
    await Promise.all([...this.procs.values()].map((s) => s.exited.catch(() => undefined)));
    await this.bridge?.stop([this.groupId]).catch(() => undefined);
    if (this.redis) {
      // Only our own keys (waiting-room event 1, limiter buckets) in our own logical DB; never FLUSHDB/FLUSHALL.
      for (const pattern of ["wr:1:*", "rl:*"]) {
        let cursor = "0";
        do {
          const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
          cursor = next;
          if (keys.length) await this.redis.unlink(...keys);
        } while (cursor !== "0");
      }
      this.redis.disconnect();
    }
    await this.pool?.end().catch(() => undefined);
    await this.scratch?.drop().catch(() => undefined);
  }
}
