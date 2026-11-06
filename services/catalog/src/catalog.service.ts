import { Pool } from "pg";
import { timed } from "./metrics";

/** ilike: sequential scan; fts: GIN index, ranked by ts_rank; fts-date: GIN index, ordered by date (no ranking). */
export type SearchStrategy = "ilike" | "fts" | "fts-date";
export interface EventRow { id: number; title: string; city: string; venue: string; starts_at: string }

export class CatalogService {
  dbQueries = 0; // observable in tests: how often the database was really hit

  constructor(private readonly pool: Pool) {}

  async search(q: string, city: string | undefined, limit: number, strategy: SearchStrategy = "fts"): Promise<EventRow[]> {
    this.dbQueries++;
    return timed(`search_${strategy.replace("-", "_")}`, () => this.runSearch(q, city, limit, strategy));
  }

  private async runSearch(q: string, city: string | undefined, limit: number, strategy: SearchStrategy): Promise<EventRow[]> {
    if (strategy === "ilike") {
      return (await this.pool.query(
        `SELECT id, title, city, venue, starts_at FROM catalog.events
         WHERE (title ILIKE $1 OR description ILIKE $1) AND ($2::text IS NULL OR city = $2)
         ORDER BY starts_at LIMIT $3`, [`%${q}%`, city ?? null, limit])).rows;
    }
    if (strategy === "fts-date") {
      return (await this.pool.query(
        `SELECT id, title, city, venue, starts_at FROM catalog.events
         WHERE search @@ plainto_tsquery('simple', $1) AND ($2::text IS NULL OR city = $2)
         ORDER BY starts_at LIMIT $3`, [q, city ?? null, limit])).rows;
    }
    return (await this.pool.query(
      `SELECT id, title, city, venue, starts_at FROM catalog.events
       WHERE search @@ plainto_tsquery('simple', $1) AND ($2::text IS NULL OR city = $2)
       ORDER BY ts_rank(search, plainto_tsquery('simple', $1)) DESC, starts_at LIMIT $3`, [q, city ?? null, limit])).rows;
  }

  async get(id: number): Promise<EventRow | null> {
    this.dbQueries++;
    return timed("get", async () => (await this.pool.query("SELECT id, title, city, venue, starts_at FROM catalog.events WHERE id=$1", [id])).rows[0] ?? null);
  }

  async rename(id: number, title: string): Promise<void> {
    await this.pool.query("UPDATE catalog.events SET title=$2 WHERE id=$1", [id, title]);
  }
}
