import { Kafka, IHeaders } from "kafkajs";
import { contextFromHeaders, getLogger, runWithContext } from "@boxoffice/platform";
import { DeadLetter, InFlight, NotificationHandler, PaymentEvent } from "./handler";
import { consumerLag, dlq as dlqCounter } from "./metrics";

export interface ConsumerOptions { broker: string; topic: string; groupId: string; concurrency?: number; partitionsConcurrently?: number }

/**
 * Consumes `payments`. Within a batch messages are handled concurrently (they are independent users),
 * offsets are committed only after the whole batch is handled. A dead-lettered message is published to
 * `<topic>.dlq` and then counts as handled, so one poison message never blocks the partition.
 */
export async function runConsumer(handler: NotificationHandler, o: ConsumerOptions) {
  const kafka = new Kafka({ clientId: "notifications", brokers: [o.broker] });
  const consumer = kafka.consumer({ groupId: o.groupId });
  const dlq = kafka.producer();
  await dlq.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: o.topic, fromBeginning: true });
  const conc = o.concurrency ?? 25;

  await consumer.run({
    partitionsConsumedConcurrently: o.partitionsConcurrently ?? 1,
    eachBatchAutoResolve: false,
    eachBatch: async ({ batch, resolveOffset, heartbeat, commitOffsetsIfNecessary }) => {
      for (let i = 0; i < batch.messages.length; i += conc) {
        const chunk = batch.messages.slice(i, i + conc);
        await Promise.all(chunk.map(async (m) => {
          const raw = m.value?.toString() ?? "";
          // The producer put x-request-id / traceparent in the Kafka headers: continue the same trace here, new span for this hop.
          const traceHeaders = headerStrings(m.headers);
          const ctx = contextFromHeaders(traceHeaders);
          try { await runWithContext(ctx, () => handleWithInFlightRetry(handler, parseEvent(raw))); }
          catch (err) {
            if (err instanceof DeadLetter || err instanceof SyntaxError) {
              dlqCounter.inc();
              runWithContext(ctx, () => getLogger().warn("message dead-lettered", { err, topic: o.topic, partition: batch.partition, offset: m.offset }));
              await dlq.send({ topic: `${o.topic}.dlq`, messages: [{ key: m.key, value: raw, headers: { ...traceHeaders, error: String(err.message) } }] });
            } else throw err;
          }
        }));
        chunk.forEach((m) => resolveOffset(m.offset));
        await commitOffsetsIfNecessary();
        await heartbeat();
      }
      if (typeof batch.offsetLag === "function") consumerLag.set({ partition: String(batch.partition) }, Number(batch.offsetLag()));
    }
  });
  return { stop: async () => { await consumer.disconnect(); await dlq.disconnect(); } };
}

/**
 * Valid JSON is not enough: `null`, a number, or an object without outboxId would make the handler throw a TypeError or a
 * NOT NULL violation, which is not a DeadLetter, so the batch would fail and be redelivered forever (a poison pill that
 * blocks the partition). A SyntaxError is routed to the DLQ by the caller.
 */
export function parseEvent(raw: string): PaymentEvent {
  const e = JSON.parse(raw) as Partial<PaymentEvent> | null;
  if (typeof e !== "object" || e === null || !Number.isSafeInteger(e.outboxId) || typeof e.eventType !== "string" || typeof e.userId !== "string" || !Array.isArray(e.seatIds)) {
    throw new SyntaxError("not a payment event");
  }
  return e as PaymentEvent;
}

function headerStrings(h: IHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) { const x = Array.isArray(v) ? v[0] : v; if (x !== undefined) out[k] = x.toString(); }
  return out;
}

/** A duplicate that lands next to its original is "in flight": wait briefly and re-check instead of failing the batch. */
async function handleWithInFlightRetry(handler: NotificationHandler, e: PaymentEvent): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await handler.handle(e); return; }
    catch (err) {
      if (!(err instanceof InFlight) || attempt >= 20) throw err; // after ~2 s give up: batch redelivery takes over
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
