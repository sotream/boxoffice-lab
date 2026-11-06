# ADR 001: Postgres full-text search, not Elasticsearch/OpenSearch (yet)

**Status:** accepted for this scale; revisit triggers listed below.

| Option | Verdict |
|---|---|
| `ILIKE '%term%'` | Fine for common words with a selective filter, **collapses on rare terms** (full scan: 16 RPS, 2.8 s p50 at 200k rows). Not acceptable as the only strategy. No `pg_trgm` GIN index was tried; with one, a leading-wildcard ILIKE does not have to scan the whole table, so the ~390x below compares GIN full-text search with an unindexed ILIKE. |
| **Postgres tsvector + GIN** | Chosen: transactional with the data (no sync pipeline, no stale index), weighted ranking, about 390x faster than ILIKE on rare terms. |
| Elasticsearch / OpenSearch | Not run in this lab. Wins on typo tolerance, facets, synonyms, relevance tuning, horizontal scale. Costs: a second system, an indexing pipeline (CDC or dual write), eventual consistency, an operations burden. |

## Revisit when
- search needs typo tolerance/synonyms/language analysers beyond Postgres dictionaries;
- the corpus exceeds what one node serves at target latency (tens of millions of documents);
- faceting and aggregations become the core feature.

## The measured lesson
"Index vs scan" is not the whole story: **ranking cost is O(matches)**. For common terms, `ORDER BY ts_rank` scores every match (536 RPS) while ordering by a b-tree column stops early (3 199 RPS, 6.0x more). On common terms with a city filter, date-ordered FTS is now only about 1.1x faster than ILIKE (3 199 vs 2 839 RPS) and its p99 is higher (75.4 vs 41.6 ms): the GIN index pays off on selective terms, not on common ones. Rank only what you need: take the top-N candidates by a cheap key, or cache the ranked result.

# ADR 002: cache-aside in Redis with single-flight and TTL jitter

- **Cache-aside** over write-through: the data changes rarely and a miss is cheap to repair; write-through would couple the catalog writer to every cached search shape.
- **Single-flight**: 100 concurrent misses for one key run one query (tested). It is per process, so the worst case is instances x 1 query per key instead of requests x 1.
- **TTL jitter**: prevents a cohort of keys from expiring together (a synchronised miss wave).
- **Staleness is a deliberate trade**: after a rename the old title is served until the key is invalidated or expires (tested). Event detail is invalidated on write; search results are allowed to age out (<= 36 s).
- Not done, noted: negative caching of empty results, request collapsing across instances (Redis lock), stale-while-revalidate.
