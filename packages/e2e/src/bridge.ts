import { Kafka, logLevel } from "kafkajs";
import { prng } from "./prng";

export const BROKER = "localhost:59092";
export interface SeenEvent { outboxId: number; eventType: string; paymentId: number; userId: string; headers: Record<string, string> }

/**
 * Payments publishes to the fixed topic `payments` (the outbox rows carry the topic name; there is no env switch), and the topic is
 * shared with other suites and drills. Notifications reads from the beginning, so pointing it at `payments` would make it process
 * foreign events whose outbox ids collide with ours. This bridge keeps the run private: it consumes `payments` with its own group
 * (from the end, started before any traffic), keeps ONLY the events of this run (userId prefix) and republishes them unchanged
 * (key, value, headers) to a private topic that the notifications process consumes. It is at-least-once like the rest of the chain.
 */
export class Bridge {
  readonly seen: SeenEvent[] = [];
  /** Duplicates the bridge injected on purpose (the relay can also produce some after a crash). */
  injectedDuplicates = 0;
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopped = false;
  private constructor(private readonly kafka: Kafka, private readonly consumer: ReturnType<Kafka["consumer"]>, private readonly producer: ReturnType<Kafka["producer"]>, readonly topic: string) {}

  static async start(runId: string, userPrefix: string, dupRate = 0, seed = 1): Promise<Bridge> {
    const rnd = prng(seed);
    const kafka = new Kafka({ clientId: `e2e-bridge-${runId}`, brokers: [BROKER], logLevel: logLevel.NOTHING });
    const topic = `e2e-${runId}.payments`;
    const admin = kafka.admin();
    await admin.connect();
    const have = await admin.listTopics();
    const want = [topic, `${topic}.dlq`, ...(have.includes("payments") ? [] : ["payments"])];
    await admin.createTopics({ topics: want.map((t) => ({ topic: t, numPartitions: 1 })) });
    await admin.disconnect();

    const producer = kafka.producer();
    await producer.connect();
    const consumer = kafka.consumer({ groupId: `e2e-bridge-${runId}` });
    await consumer.connect();
    await consumer.subscribe({ topic: "payments", fromBeginning: false });
    const b = new Bridge(kafka, consumer, producer, topic);
    const joined = new Promise<void>((r) => consumer.on(consumer.events.GROUP_JOIN, () => r()));
    await consumer.run({
      eachMessage: async ({ message }) => {
        let ev: { outboxId: number; eventType: string; paymentId: number; userId: string };
        try { ev = JSON.parse(message.value?.toString() ?? ""); } catch { return; }
        if (typeof ev?.userId !== "string" || !ev.userId.startsWith(userPrefix)) return; // someone else's event
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(message.headers ?? {})) if (v !== undefined) headers[k] = Array.isArray(v) ? String(v[0]) : v.toString();
        b.seen.push({ outboxId: ev.outboxId, eventType: ev.eventType, paymentId: ev.paymentId, userId: ev.userId, headers });
        const m = { key: message.key, value: message.value, headers: message.headers };
        // At-least-once on purpose: some events arrive twice back to back (a duplicate that lands next to its original, so the
        // consumer must handle the "in flight elsewhere" lease), and some again 2 s later (a late redelivery after the original was SENT).
        const x = rnd();
        const twice = x < dupRate;
        if (twice) { b.injectedDuplicates++; b.seen.push({ ...b.seen[b.seen.length - 1] }); }
        await producer.send({ topic, messages: twice ? [m, m] : [m] });
        if (x >= dupRate && x < dupRate * 1.5) {
          b.injectedDuplicates++; b.seen.push({ ...b.seen[b.seen.length - 1] });
          const t = setTimeout(() => { b.timers.delete(t); if (!b.stopped) void producer.send({ topic, messages: [m] }).catch(() => undefined); }, 2000);
          b.timers.add(t);
        }
      }
    });
    await joined;
    await new Promise((r) => setTimeout(r, 1500)); // let the first fetch resolve the "latest" offset before any traffic
    return b;
  }

  /** Messages in the private dead-letter topic (should be 0). */
  /** Late duplicates still scheduled. */
  get pending(): number { return this.timers.size; }

  async dlqSize(): Promise<number> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const offs = await admin.fetchTopicOffsets(`${this.topic}.dlq`);
      return offs.reduce((n, o) => n + (Number(o.high) - Number(o.low)), 0);
    } finally { await admin.disconnect(); }
  }

  async stop(extraGroups: string[] = []): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    await this.consumer.disconnect().catch(() => undefined);
    await this.producer.disconnect().catch(() => undefined);
    const admin = this.kafka.admin();
    try {
      await admin.connect();
      await admin.deleteTopics({ topics: [this.topic, `${this.topic}.dlq`] });
      await admin.deleteGroups([`e2e-bridge-${this.topic.split("-")[1].split(".")[0]}`, ...extraGroups]).catch(() => undefined); // may refuse while a killed member's session has not expired
    } catch { /* best effort */ } finally { await admin.disconnect().catch(() => undefined); }
  }
}
