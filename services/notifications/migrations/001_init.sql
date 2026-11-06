CREATE SCHEMA IF NOT EXISTS notifications;
-- One row per (event, channel): the dedup key and the delivery state.
CREATE TABLE IF NOT EXISTS notifications.deliveries (
  outbox_id  bigint NOT NULL,
  channel    text   NOT NULL,
  status     text   NOT NULL DEFAULT 'SENDING', -- SENDING | SENT | FAILED
  attempts   int    NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outbox_id, channel)
);
