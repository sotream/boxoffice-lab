import { join } from "node:path";
import { createPool as createSharedPool, migrate as migrateDir } from "@boxoffice/platform";
import { Pool } from "pg";

/** statementTimeoutMs 0 disables it: migrations and seeding are bulk operations, not request traffic. */
export function createPool(max = 20, statementTimeoutMs = 5000): Pool {
  return createSharedPool({ max, statementTimeoutMs, applicationName: "catalog" });
}
export async function migrate(pool: Pool): Promise<void> {
  await migrateDir(pool, join(__dirname, "..", "migrations"));
}

export const ARTISTS = ["rock", "jazz", "opera", "techno", "folk", "metal", "ballet", "comedy", "football", "tennis", "festival", "musical", "orchestra", "stand-up", "marathon", "circus"];
export const CITIES = ["Berlin", "Munich", "Hamburg", "Cologne", "Frankfurt", "Vienna", "Zurich", "Prague", "Warsaw", "Kyiv", "Lviv", "Paris", "Madrid", "Rome", "Amsterdam", "Lisbon"];

/** Deterministic synthetic catalog so benchmark runs are comparable. */
export async function seed(pool: Pool, n: number): Promise<void> {
  await pool.query("TRUNCATE catalog.events RESTART IDENTITY");
  await pool.query(
    `INSERT INTO catalog.events (title, city, venue, starts_at, description)
     SELECT
       (ARRAY[${ARTISTS.map((a) => `'${a}'`).join(",")}])[1 + (g * 7) % ${ARTISTS.length}] || ' night ' || g,
       (ARRAY[${CITIES.map((c) => `'${c}'`).join(",")}])[1 + (g * 13 + g / 16) % ${CITIES.length}],
       'Arena ' || (g % 500),
       now() + (g % 365) * interval '1 day',
       'Live ' || (ARRAY[${ARTISTS.map((a) => `'${a}'`).join(",")}])[1 + (g * 3) % ${ARTISTS.length}] || ' show number ' || g || ' with special guests'
     FROM generate_series(1, $1) g`, [n]);
  await pool.query("ANALYZE catalog.events");
}
