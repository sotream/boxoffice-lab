import { Pool } from "pg";

export interface OutMessage { key: string; value: string; headers?: Record<string, string> }
export type Publish = (topic: string, messages: OutMessage[]) => Promise<void>;

/** Kafka headers from the correlation fields the payment path stored in the payload (`trace`), if any. */
export function traceHeaders(payload: unknown): Record<string, string> | undefined {
  const t = (payload as { trace?: { requestId?: unknown; traceparent?: unknown } } | null)?.trace;
  if (!t) return undefined;
  const h: Record<string, string> = {};
  if (typeof t.requestId === "string") h["x-request-id"] = t.requestId;
  if (typeof t.traceparent === "string") h["traceparent"] = t.traceparent;
  return Object.keys(h).length ? h : undefined;
}

/**
 * Polls the outbox and publishes to the broker. At-least-once: if we crash after publish but before
 * marking published, the row is sent again, so consumers must deduplicate (they use the outbox id).
 * FOR UPDATE SKIP LOCKED lets several relay instances run without sending the same row concurrently.
 */
export class OutboxRelay {
  constructor(private readonly pool: Pool, private readonly publish: Publish, private readonly batch = 100) {}

  async drainOnce(): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rows = (await client.query(
        `SELECT id, topic, key, payload FROM payments.outbox WHERE published_at IS NULL
         ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, [this.batch])).rows;
      if (rows.length === 0) { await client.query("COMMIT"); return 0; }
      const byTopic = new Map<string, OutMessage[]>();
      for (const r of rows) {
        const list = byTopic.get(r.topic) ?? [];
        list.push({ key: r.key, value: JSON.stringify({ outboxId: r.id, ...r.payload }), headers: traceHeaders(r.payload) });
        byTopic.set(r.topic, list);
      }
      for (const [topic, msgs] of byTopic) await this.publish(topic, msgs);
      await client.query("UPDATE payments.outbox SET published_at=now() WHERE id = ANY($1)", [rows.map((r) => r.id)]);
      await client.query("COMMIT");
      return rows.length;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }
}
