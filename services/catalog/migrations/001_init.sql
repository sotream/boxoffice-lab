CREATE SCHEMA IF NOT EXISTS catalog;
CREATE TABLE IF NOT EXISTS catalog.events (
  id          serial PRIMARY KEY,
  title       text NOT NULL,
  city        text NOT NULL,
  venue       text NOT NULL,
  starts_at   timestamptz NOT NULL,
  description text NOT NULL DEFAULT '',
  search      tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('simple', title), 'A') ||
                setweight(to_tsvector('simple', venue || ' ' || city), 'B') ||
                setweight(to_tsvector('simple', description), 'C')) STORED
);
CREATE INDEX IF NOT EXISTS events_search_gin ON catalog.events USING gin (search);
CREATE INDEX IF NOT EXISTS events_city_start ON catalog.events (city, starts_at);
