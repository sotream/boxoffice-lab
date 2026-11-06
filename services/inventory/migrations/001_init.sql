CREATE TABLE IF NOT EXISTS seats (
  event_id   int  NOT NULL,
  seat_id    int  NOT NULL,
  status     text NOT NULL DEFAULT 'free' CHECK (status IN ('free','held','sold')),
  held_by    text,
  hold_until timestamptz,
  PRIMARY KEY (event_id, seat_id)
);
CREATE INDEX IF NOT EXISTS seats_free_idx ON seats (event_id, status);
