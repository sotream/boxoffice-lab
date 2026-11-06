# catalog

Interview questions: **"Design search for an events site"**, **"Postgres full-text vs Elasticsearch"**, **"Where does the cache go and what breaks it?"**

## Requirements
- FR: search events by words, optional city filter; fetch one event by id.
- NFR: read-heavy (100:1 vs writes), p99 < 50 ms, tolerate seconds of staleness (a renamed event may show the old title for <= 30 s).

## API
`GET /search?q=&city=&strategy=ilike|fts|fts-date&cache=0|1`, `GET /events/:id`

## Design
Postgres table with a generated `tsvector` column and a GIN index; Redis cache-aside in front with single-flight and TTL jitter. Three search strategies are kept side by side on purpose, so the numbers can be compared.

See [CAPACITY.md](CAPACITY.md), [adr/](adr/), [RESULTS.md](RESULTS.md).
