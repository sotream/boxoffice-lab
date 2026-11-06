import { counter, histogram } from "@boxoffice/platform";

/** result: hit | miss (this call runs the loader) | coalesced (joined an in-flight load) | error (Redis failed, treated as a miss). */
export const cacheRequests = counter("catalog_cache_requests_total", "Cache lookups by result.", ["result"]);
/** op: search_ilike | search_fts | search_fts_date | get. Only queries that reach Postgres (cache misses). */
export const dbQueryDuration = histogram("catalog_db_query_duration_seconds", "Postgres query time for catalog reads.", ["op"]);

export async function timed<T>(op: string, fn: () => Promise<T>): Promise<T> {
  const end = dbQueryDuration.startTimer({ op });
  try { return await fn(); } finally { end(); }
}
