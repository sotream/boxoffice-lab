import { join } from "node:path";
import { createPool as createSharedPool, migrate as migrateDir } from "@boxoffice/platform";
import { Pool } from "pg";

/** statementTimeoutMs 0 disables it (migrations and bulk work); request-path pools keep the 5 s default. */
export function createPool(max = 20, statementTimeoutMs = 5000): Pool {
  return createSharedPool({ max, statementTimeoutMs, applicationName: "notifications" });
}
export async function migrate(pool: Pool): Promise<void> {
  await migrateDir(pool, join(__dirname, "..", "migrations"));
}
