import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, ParseIntPipe, Query } from "@nestjs/common";
import { Cache } from "./cache";
import { CatalogService, SearchStrategy } from "./catalog.service";

@Controller()
export class CatalogController {
  constructor(@Inject(CatalogService) private readonly svc: CatalogService, @Inject(Cache) private readonly cache: Cache) {}

  @Get("search")
  async search(@Query("q") q: string, @Query("city") city?: string, @Query("strategy") strategy?: SearchStrategy, @Query("cache") cache?: string) {
    if (!q || q.length > 100) throw new BadRequestException("q required (max 100 chars)");
    // Postgres text cannot hold NUL: without this check the driver error would surface as a 500.
    if (q.includes("\u0000") || city?.includes("\u0000")) throw new BadRequestException("NUL is not allowed");
    const s: SearchStrategy = strategy === "ilike" || strategy === "fts-date" ? strategy : "fts";
    const c = city || undefined; // an empty ?city= means "any city", not the city named ""
    const run = () => this.svc.search(q, c, 20, s);
    // JSON-encoded tuple: unambiguous, a ":" inside city or q cannot shift fields into a neighbour's key
    return cache === "0" ? run() : this.cache.getOrLoad(`search:${JSON.stringify([s, c ?? null, q.toLowerCase()])}`, run);
  }

  @Get("events/:id")
  async get(@Param("id", ParseIntPipe) id: number) {
    if (id > 2_147_483_647) throw new NotFoundException(); // beyond int4: no such row, and the query would fail with a 500
    const e = await this.cache.getOrLoad(`event:${id}`, () => this.svc.get(id));
    if (!e) throw new NotFoundException();
    return e;
  }
}
