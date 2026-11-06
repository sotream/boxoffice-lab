import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";

/** Helpers for tests that run a BUILT service as a child process. Not used by production code. */

/** Compile a package so `dist/main.js` matches the sources (incremental, a few seconds). Throws with tsc output on failure. */
export function ensureBuilt(pkgDir: string): void {
  try { execFileSync(join(pkgDir, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: pkgDir, stdio: "pipe" }); }
  catch (e) { throw new Error(`build of ${pkgDir} failed:\n${(e as { stdout?: Buffer }).stdout?.toString()}`); }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
  });
}

export interface RunningService { child: ChildProcess; output: () => string; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }

export function spawnService(pkgDir: string, env: Record<string, string>, entry = "dist/main.js"): RunningService {
  const child = spawn(process.execPath, [entry], { cwd: pkgDir, env: { ...process.env, LOG_LEVEL: "info", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once("exit", (code, signal) => r({ code, signal })));
  return { child, output: () => out, exited };
}

export async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 15_000, every = 100): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    try { if (await fn()) return; } catch { /* not yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, every));
  }
}

export const waitHealthy = (base: string, path = "/healthz", timeoutMs = 20_000) => waitUntil(async () => (await fetch(`${base}${path}`)).status === 200, timeoutMs);

/**
 * A private, empty Postgres database for a test that starts a service with background workers (sweeper, relay): those would
 * otherwise act on rows that other tests in the shared lab database are asserting on. `drop()` removes only this database.
 */
export async function createScratchDatabase(prefix: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const { Pool } = await import("pg");
  const base = new URL(process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:55432/lab");
  const name = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-z0-9_]/g, "_");
  const admin = new Pool({ connectionString: base.toString(), max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(base); url.pathname = `/${name}`;
  return { url: url.toString(), drop: async () => { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); } };
}
