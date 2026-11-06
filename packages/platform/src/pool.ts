import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Pool } from "pg";
import { getLogger } from "./logger";

export const DEFAULT_DATABASE_URL = "postgres://lab:lab@localhost:55432/lab";

export interface PoolOptions {
  max?: number;
  /** 0 disables the statement timeout (bulk operations only: migrations, seeding). */
  statementTimeoutMs?: number;
  connectionTimeoutMs?: number;
  idleTimeoutMs?: number;
  applicationName?: string;
  connectionString?: string;
}

/**
 * The one way services build a Postgres pool. Defaults: 20 connections, 5 s statement timeout, 2 s wait for a connection.
 * The 'error' handler matters: an idle client that loses its connection emits 'error' on the pool, and without a listener
 * Node treats it as an unhandled error event and the process dies.
 */
export function createPool(o: PoolOptions = {}): Pool {
  const pool = new Pool({
    connectionString: o.connectionString ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    max: o.max ?? 20,
    connectionTimeoutMillis: o.connectionTimeoutMs ?? 2000,
    statement_timeout: o.statementTimeoutMs ?? 5000,
    application_name: o.applicationName,
    idleTimeoutMillis: o.idleTimeoutMs
  });
  pool.on("error", (err) => getLogger().error("idle postgres client error", { err, application: o.applicationName }));
  return pool;
}

/**
 * Apply the `*.sql` files of `dir` in name order, each at most once. What was applied is recorded in `public.schema_migrations`
 * under `scope` (default: the service directory name, e.g. `payments` for `services/payments/migrations`), in the same
 * transaction as the file itself, so a failed file leaves no record and is retried on the next boot. A session advisory lock
 * serialises instances that boot at the same time, so `CREATE TABLE IF NOT EXISTS` races cannot crash a second instance.
 * Runs on one connection with the statement timeout switched off (migrations are bulk DDL, not request traffic) and
 * restores the pool's setting afterwards. Databases migrated before the tracking existed re-run each file once (files are
 * written to be idempotent) and are recorded from then on.
 */
export async function migrate(pool: Pool, dir: string, scope: string = basename(dirname(dir))): Promise<void> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 0");
    await client.query("SELECT pg_advisory_lock(hashtext('boxoffice-lab:migrate'))");
    try {
      await client.query("CREATE TABLE IF NOT EXISTS public.schema_migrations (scope text NOT NULL, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (scope, name))");
      const done = new Set((await client.query("SELECT name FROM public.schema_migrations WHERE scope=$1", [scope])).rows.map((r) => r.name as string));
      for (const f of files) {
        if (done.has(f)) continue;
        await client.query("BEGIN");
        try {
          await client.query(readFileSync(join(dir, f), "utf8"));
          await client.query("INSERT INTO public.schema_migrations (scope, name) VALUES ($1, $2)", [scope, f]);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw e;
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('boxoffice-lab:migrate'))").catch(() => undefined);
    }
  } finally {
    await client.query("RESET statement_timeout").catch(() => undefined);
    client.release();
  }
}
