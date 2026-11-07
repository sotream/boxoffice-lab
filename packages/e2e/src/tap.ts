import { Kafka, logLevel } from "kafkajs";
import type { SeenEvent } from "./bridge";

/**
 * What the fault scenarios use instead of the Bridge: their Redpanda is private, so notifications can read the real topic `payments`
 * directly and nothing has to be copied. The tap only observes: `sync()` reads the whole topic from the beginning with a throw-away
 * consumer (so it also works after the broker was stopped and started) and fills `seen` with one entry per message copy,
 * in log order. It injects nothing: duplicates counted here are the relay's own.
 */
export class Tap {
  readonly seen: (SeenEvent & { offset: number; key: string })[] = [];
  readonly injectedDuplicates = 0;
  readonly pending = 0;
  readonly topic = "payments";
  constructor(private readonly broker: string, private readonly userPrefix = "") {}

  private kafka() { return new Kafka({ clientId: `e2e-tap-${Date.now()}`, brokers: [this.broker], logLevel: logLevel.NOTHING, retry: { retries: 8 } }); }

  async sync(): Promise<void> {
    this.seen.length = 0;
    const kafka = this.kafka();
    const admin = kafka.admin();
    await admin.connect();
    let want = 0;
    try {
      for (const o of await admin.fetchTopicOffsets(this.topic)) want += Number(o.high) - Number(o.low);
    } finally { await admin.disconnect(); }
    if (want === 0) return;
    const consumer = kafka.consumer({ groupId: `e2e-tap-${Date.now()}-${Math.random().toString(36).slice(2)}` });
    await consumer.connect();
    await consumer.subscribe({ topic: this.topic, fromBeginning: true });
    let got = 0;
    const done = new Promise<void>((resolve) => {
      void consumer.run({
        eachMessage: async ({ message }) => {
          got++;
          try {
            const ev = JSON.parse(message.value?.toString() ?? "");
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(message.headers ?? {})) if (v !== undefined) headers[k] = Array.isArray(v) ? String(v[0]) : v.toString();
            if (typeof ev?.userId === "string" && ev.userId.startsWith(this.userPrefix)) this.seen.push({ outboxId: ev.outboxId, eventType: ev.eventType, paymentId: ev.paymentId, userId: ev.userId, headers, offset: Number(message.offset), key: message.key?.toString() ?? "" });
          } catch { /* not an event */ }
          if (got >= want) resolve();
        }
      });
    });
    try { await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error(`tap read ${got} of ${want} messages`)), 30_000))]); }
    finally { await consumer.disconnect().catch(() => undefined); }
  }

  /** Messages in `payments.dlq` (should be 0). */
  async dlqSize(): Promise<number> {
    const admin = this.kafka().admin();
    await admin.connect();
    try {
      const offs = await admin.fetchTopicOffsets(`${this.topic}.dlq`);
      return offs.reduce((n, o) => n + (Number(o.high) - Number(o.low)), 0);
    } catch { return 0; } finally { await admin.disconnect().catch(() => undefined); }
  }

  async stop(): Promise<void> { /* nothing running */ }
}
