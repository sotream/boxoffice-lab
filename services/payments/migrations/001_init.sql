CREATE SCHEMA IF NOT EXISTS payments;

CREATE TABLE IF NOT EXISTS payments.payments (
  id              bigserial PRIMARY KEY,
  idempotency_key text   NOT NULL UNIQUE,
  event_id        int    NOT NULL,
  user_id         text   NOT NULL,
  seat_ids        int[]  NOT NULL,
  amount_cents    int    NOT NULL,
  -- saga state: PENDING -> CHARGED -> CONFIRMED | REFUNDED | FAILED
  status          text   NOT NULL DEFAULT 'PENDING',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Transactional outbox: written in the same transaction as the state change.
CREATE TABLE IF NOT EXISTS payments.outbox (
  id           bigserial PRIMARY KEY,
  topic        text  NOT NULL,
  key          text  NOT NULL,
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished ON payments.outbox (id) WHERE published_at IS NULL;
