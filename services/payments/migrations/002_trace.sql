-- Correlation of the request that created the payment ({requestId, traceparent}), so a saga finished later by the
-- sweeper (after a 202) still emits its outbox event, and the Kafka headers, under the original trace.
ALTER TABLE payments.payments ADD COLUMN IF NOT EXISTS trace jsonb;
