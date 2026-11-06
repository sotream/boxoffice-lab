import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export const DEFAULT_URL = "postgres://lab:lab@localhost:55432/lab";

/** statementTimeoutMs 0 disables it: migrations and seeding are bulk operations, not request traffic. */
export function createPool(max = Number(process.env.PG_POOL ?? 20), statementTimeoutMs = 5000): Pool {
  return new Pool({ connectionString: process.env.DATABASE_URL ?? DEFAULT_URL, max, connectionTimeoutMillis: 2000, statement_timeout: statementTimeoutMs });
}

export async function migrate(pool: Pool): Promise<void> {
  const sql = readFileSync(join(__dirname, "..", "migrations", "001_init.sql"), "utf8");
  await pool.query(sql);
}

export async function seed(pool: Pool, eventId: number, seats: number): Promise<void> {
  await pool.query("DELETE FROM seats WHERE event_id=$1", [eventId]);
  await pool.query(
    "INSERT INTO seats (event_id, seat_id) SELECT $1, g FROM generate_series(1, $2) g",
    [eventId, seats]
  );
}
