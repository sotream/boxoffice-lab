import { Kafka } from "kafkajs";
import { DeadLetter, InFlight, NotificationHandler, PaymentEvent } from "./handler";

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
          try { await handleWithInFlightRetry(handler, JSON.parse(raw) as PaymentEvent); }
          catch (err) {
            if (err instanceof DeadLetter || err instanceof SyntaxError) {
              await dlq.send({ topic: `${o.topic}.dlq`, messages: [{ key: m.key, value: raw, headers: { error: String(err.message) } }] });
            } else throw err;
          }
        }));
        chunk.forEach((m) => resolveOffset(m.offset));
        await commitOffsetsIfNecessary();
        await heartbeat();
      }
    }
  });
  return { stop: async () => { await consumer.disconnect(); await dlq.disconnect(); } };
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
