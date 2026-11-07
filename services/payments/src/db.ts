import { join } from "node:path";
import { createPool as createSharedPool, migrate as migrateDir } from "@boxoffice/platform";
import { Pool } from "pg";

/** Statement timeout 5 s by default; migrations (below) switch it off for their own connection. */
export function createPool(max = 20, statementTimeoutMs = 5000, applicationName = "payments"): Pool {
  return createSharedPool({ max, statementTimeoutMs, applicationName });
}

export async function migrate(pool: Pool): Promise<void> {
  await migrateDir(pool, join(__dirname, "..", "migrations"));
}
