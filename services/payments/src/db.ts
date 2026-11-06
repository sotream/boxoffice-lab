import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export function createPool(max = 20): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://lab:lab@localhost:55432/lab", max, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(readFileSync(join(__dirname, "..", "migrations", "001_init.sql"), "utf8"));
}
