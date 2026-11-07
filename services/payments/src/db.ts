import { join } from "node:path";
import { createPool as createSharedPool, migrate as migrateDir } from "@boxoffice/platform";
import { Pool } from "pg";

/** Statement timeout 5 s by default; migrations (below) switch it off for their own connection. */
export function createPool(max = 20, statementTimeoutMs = 5000, applicationName = "payments"): Pool {
  const pool = createSharedPool({ max, statementTimeoutMs, applicationName });
  // pg removes its own error listener from a client while it is checked out (inside a transaction, between two queries). If Postgres goes
  // away at that moment the client emits 'error' with nobody listening and Node kills the process (found by the fault suite: docker stop of
  // Postgres under load). The failing query still rejects on its own and the dead client is discarded on release.
  pool.on("connect", (client) => client.on("error", () => undefined));
  return pool;
}

export async function migrate(pool: Pool): Promise<void> {
  await migrateDir(pool, join(__dirname, "..", "migrations"));
}
