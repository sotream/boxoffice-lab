import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Kafka, logLevel } from "kafkajs";
import { Pool } from "pg";
import { freePort, waitUntil } from "@boxoffice/platform";

/**
 * Private infrastructure for the fault scenarios. Postgres, Redis and Redpanda run in containers of their own (same images and
 * flags as docker-compose.yml, random host ports), so an outage is injected with the docker CLI on a container that nobody else
 * uses. The shared lab servers are never touched. Every container is removed in the scenario's afterAll, on process exit, and by
 * the global teardown, which also fails the run if any container is left over.
 */
const sh = promisify(execFile);
const ROOT = join(__dirname, "..", "..", "..");
export const NAME_PREFIX = "boxoffice-e2e-";
/** The pid of the process that owns this run's containers: the vitest main process (set by the global setup), else this one. */
export const RUN_ID = process.env.E2E_FAULTS_RUN ?? String(process.pid);

const tracked = new Set<string>();
function removeAllSync() {
  for (const n of tracked) { try { execFileSync("docker", ["rm", "-f", "-v", n], { stdio: "ignore", timeout: 30_000 }); } catch { /* gone */ } }
  tracked.clear();
}
process.on("exit", removeAllSync);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { removeAllSync(); process.exit(130); });

export async function docker(args: string[], timeoutMs = 90_000): Promise<string> {
  try { return (await sh("docker", args, { timeout: timeoutMs, maxBuffer: 8 << 20 })).stdout.trim(); }
  catch (e) { throw new Error(`docker ${args.join(" ")} failed: ${(e as { stderr?: string }).stderr ?? (e as Error).message}`); }
}

/** Image tags exactly as docker-compose.yml names them. */
function composeImage(service: string): string {
  const text = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  const m = text.match(new RegExp(`^  ${service}:\\n(?:    .*\\n)*?    image: (\\S+)`, "m"));
  if (!m) throw new Error(`no image for ${service} in docker-compose.yml`);
  return m[1];
}
const pulled = new Set<string>();
async function ensureImage(image: string) {
  if (pulled.has(image)) return;
  try { await docker(["image", "inspect", image], 20_000); } catch { await docker(["pull", image], 300_000); }
  pulled.add(image);
}

export type Kind = "postgres" | "redis" | "redpanda";
let seq = 0;

export class Container {
  readonly name: string;
  constructor(readonly kind: Kind, readonly port: number, readonly ready: () => Promise<void>) {
    this.name = `${NAME_PREFIX}${RUN_ID}-${++seq}-${kind}`;
  }
  async run(args: string[]) {
    tracked.add(this.name);
    await docker(["run", "-d", "--name", this.name, "--label", "boxoffice-e2e=1", ...args]);
  }
  /** Connections reset, ports closed. State on disk (if the server keeps any) survives. */
  async stop() { await docker(["stop", "-t", "1", this.name], 60_000); }
  async start() { await docker(["start", this.name]); await this.ready(); }
  /** Connections hang: the kernel keeps them open, nobody answers. */
  async pause() { await docker(["pause", this.name]); }
  async unpause() { await docker(["unpause", this.name]); }
  async kill() { await docker(["kill", this.name]); }
  async remove() { await docker(["rm", "-f", "-v", this.name]).catch(() => undefined); tracked.delete(this.name); }
}

export interface Infra {
  pg: Container; redis: Container; kafka: Container;
  pgUrl: string; redisUrl: string; broker: string;
  stop(): Promise<void>;
}

async function pgContainer(): Promise<Container> {
  const port = await freePort();
  const url = `postgres://lab:lab@127.0.0.1:${port}/lab`;
  const c: Container = new Container("postgres", port, async () => {
    await waitUntil(async () => {
      await docker(["exec", c.name, "pg_isready", "-U", "lab", "-h", "127.0.0.1"], 10_000);
      const p = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 2000 });
      p.on("error", () => undefined);
      try { await p.query("SELECT 1"); return true; } finally { await p.end().catch(() => undefined); }
    }, 60_000, 300);
  });
  const image = composeImage("postgres");
  await ensureImage(image);
  // the same server settings as compose
  await c.run(["-e", "POSTGRES_USER=lab", "-e", "POSTGRES_PASSWORD=lab", "-e", "POSTGRES_DB=lab", "-p", `127.0.0.1:${port}:5432`, image, "postgres", "-c", "max_connections=200", "-c", "shared_buffers=256MB"]);
  return c;
}

async function redisContainer(): Promise<Container> {
  const port = await freePort();
  const c: Container = new Container("redis", port, async () => {
    await waitUntil(async () => (await docker(["exec", c.name, "redis-cli", "ping"], 10_000)) === "PONG", 30_000, 200);
  });
  const image = composeImage("redis");
  await ensureImage(image);
  // No persistence: a stopped and started Redis comes back empty, which is what the waiting-room ADR assumes. (The compose Redis uses the
  // image defaults, which snapshot to disk on a graceful stop; this one is deliberately the harsher case.)
  await c.run(["-p", `127.0.0.1:${port}:6379`, image, "redis-server", "--save", "", "--appendonly", "no"]);
  return c;
}

async function redpandaContainer(): Promise<Container> {
  const port = await freePort();
  const c: Container = new Container("redpanda", port, async () => {
    await waitUntil(async () => {
      const out = await docker(["exec", c.name, "rpk", "cluster", "health"], 15_000);
      if (!/Healthy:\s+true/.test(out)) return false;
      const kafka = new Kafka({ clientId: "e2e-ready", brokers: [`localhost:${port}`], logLevel: logLevel.NOTHING, retry: { retries: 0 }, connectionTimeout: 2000 });
      const admin = kafka.admin();
      try { await admin.connect(); await admin.listTopics(); return true; } finally { await admin.disconnect().catch(() => undefined); }
    }, 90_000, 500);
  });
  const image = composeImage("redpanda");
  await ensureImage(image);
  await c.run(["-p", `127.0.0.1:${port}:${port}`, image, "redpanda", "start", "--smp=1", "--memory=512M", "--overprovisioned", "--node-id=0",
    `--kafka-addr=PLAINTEXT://0.0.0.0:${port}`, `--advertise-kafka-addr=PLAINTEXT://localhost:${port}`]);
  return c;
}

/** Start a private Postgres, Redis and Redpanda in parallel and wait until each is really usable. */
export async function startInfra(): Promise<Infra> {
  const made: Container[] = [];
  const infra = { stop: async () => { await Promise.all(made.map((c) => c.remove())); } } as Infra;
  try {
    const [pg, redis, kafka] = await Promise.all([pgContainer(), redisContainer(), redpandaContainer()]);
    made.push(pg, redis, kafka);
    await Promise.all([pg.ready(), redis.ready(), kafka.ready()]);
    Object.assign(infra, { pg, redis, kafka, pgUrl: `postgres://lab:lab@127.0.0.1:${pg.port}/lab`, redisUrl: `redis://127.0.0.1:${redis.port}/0`, broker: `localhost:${kafka.port}` });
    const k = new Kafka({ clientId: "e2e-topics", brokers: [infra.broker], logLevel: logLevel.NOTHING });
    const admin = k.admin();
    await admin.connect();
    try { await admin.createTopics({ topics: [{ topic: "payments", numPartitions: 1 }, { topic: "payments.dlq", numPartitions: 1 }], waitForLeaders: true }); } finally { await admin.disconnect(); }
    return infra;
  } catch (e) {
    // a half-started world must not leak: remove whatever was created (the constructors are not reachable, so remove by name prefix)
    await removeByPrefix(`${NAME_PREFIX}${RUN_ID}-`).catch(() => undefined);
    throw e;
  }
}

/** Containers whose name starts with `prefix`, running or not. */
export async function listContainers(prefix = NAME_PREFIX): Promise<string[]> {
  const out = await docker(["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{.Names}}"], 30_000);
  return out ? out.split("\n").filter(Boolean) : [];
}
export async function removeByPrefix(prefix: string): Promise<string[]> {
  const names = await listContainers(prefix);
  if (names.length) await docker(["rm", "-f", "-v", ...names], 60_000);
  for (const n of names) tracked.delete(n);
  return names;
}
