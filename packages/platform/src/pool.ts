import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
 * Apply every *.sql file in `dir` in name order, on one connection with the statement timeout switched off
 * (migrations are bulk DDL, not request traffic), and restore the pool's setting afterwards.
 */
export async function migrate(pool: Pool, dir: string): Promise<void> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = 0");
    for (const f of files) await client.query(readFileSync(join(dir, f), "utf8"));
  } finally {
    await client.query("RESET statement_timeout").catch(() => undefined);
    client.release();
  }
}
