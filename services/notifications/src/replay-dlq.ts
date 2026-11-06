import { Kafka } from "kafkajs";

/**
 * Re-publish everything in `<topic>.dlq` to `<topic>` (run after the cause is fixed).
 * Safe to run twice: the handler dedups on (outboxId, channel), so already delivered channels are skipped.
 * Stops when the DLQ has been idle for `idleMs`. Does not delete from the DLQ (a log); the replay marker header lets you tell replays apart.
 */
export async function replayDlq(broker: string, topic: string, idleMs = 3000): Promise<number> {
  const kafka = new Kafka({ clientId: "dlq-replay", brokers: [broker] });
  const consumer = kafka.consumer({ groupId: `dlq-replay-${Date.now()}` }); // fresh group = read from the beginning
  const producer = kafka.producer();
  await Promise.all([consumer.connect(), producer.connect()]);
  await consumer.subscribe({ topic: `${topic}.dlq`, fromBeginning: true });
  const messages: { key: Buffer | null; value: Buffer | null; headers: Record<string, string> }[] = [];
  let last = Date.now();
  await consumer.run({ eachMessage: async ({ message }) => { messages.push({ key: message.key, value: message.value, headers: { replayed: "1" } }); last = Date.now(); } });
  while (Date.now() - last < idleMs) await new Promise((r) => setTimeout(r, 200));
  await consumer.disconnect();
  if (messages.length) await producer.send({ topic, messages });
  await producer.disconnect();
  return messages.length;
}
