import { join } from "node:path";
import { createPool as createSharedPool, DEFAULT_DATABASE_URL, migrate as migrateDir } from "@boxoffice/platform";
import { Pool } from "pg";

export const DEFAULT_URL = DEFAULT_DATABASE_URL;

/** statementTimeoutMs 0 disables it: migrations and seeding are bulk operations, not request traffic. */
export function createPool(max = Number(process.env.PG_POOL ?? 20), statementTimeoutMs = 5000): Pool {
  const pool = createSharedPool({ max, statementTimeoutMs, applicationName: "inventory" });
  // pg removes its own error listener from a client while it is checked out (inside a transaction, between two queries). If Postgres goes
  // away at that moment the client emits 'error' with nobody listening and Node kills the process (found by the fault suite: docker stop of
  // Postgres under load). The failing query still rejects on its own and the dead client is discarded on release.
  pool.on("connect", (client) => client.on("error", () => undefined));
  return pool;
}

export async function migrate(pool: Pool): Promise<void> {
  await migrateDir(pool, join(__dirname, "..", "migrations"));
}

export async function seed(pool: Pool, eventId: number, seats: number): Promise<void> {
  await pool.query("DELETE FROM seats WHERE event_id=$1", [eventId]);
  await pool.query(
    "INSERT INTO seats (event_id, seat_id) SELECT $1, g FROM generate_series(1, $2) g",
    [eventId, seats]
  );
}
