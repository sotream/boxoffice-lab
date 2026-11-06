import { Pool } from "pg";
import { delivered, duplicatesSuppressed } from "./metrics";

export type Channel = "email" | "push";
export type Sender = (channel: Channel, to: string, text: string, dedupKey: string) => Promise<void>;
export interface PaymentEvent { outboxId: number; eventType: string; paymentId: number; userId: string; seatIds: number[] }

export class DeadLetter extends Error {
  constructor(readonly failedChannels: Channel[], readonly cause_: unknown) { super(`dead letter: ${failedChannels.join(",")}`); }
}

const TEMPLATES: Record<string, (e: PaymentEvent) => string> = {
  "payment.confirmed": (e) => `Your tickets (${e.seatIds.join(", ")}) are confirmed.`,
  "payment.refunded": () => "Your seats were no longer held, so we refunded you.",
  "payment.failed": () => "Your payment was declined."
};
// Fan-out: which channels each event type goes to.
const CHANNELS: Record<string, Channel[]> = {
  "payment.confirmed": ["email", "push"],
  "payment.refunded": ["email", "push"],
  "payment.failed": ["push"]
};

/** Another worker holds a fresh claim on this (event, channel). Not a failure: the batch is redelivered later. */
export class InFlight extends Error {
  constructor() { super("delivery in flight elsewhere"); }
}

export interface HandlerOptions { maxAttempts?: number; backoffMs?: number; leaseMs?: number }

/**
 * Processing is per (event, channel). The deliveries row is the dedup key AND the retry state:
 *  - SENT      -> skip (duplicate from the at-least-once pipeline)
 *  - SENDING   -> a lease: while fresh, another worker owns it (we throw InFlight, batch is redelivered);
 *                 once expired (worker crashed mid-send) it is taken over and resent. A crash can therefore cause a
 *                 duplicate email, mitigated by passing outboxId:channel as the provider's idempotency key
 *  - FAILED    -> retried on the next delivery
 * A failing channel does not resend channels that already succeeded.
 */
export class NotificationHandler {
  constructor(private readonly pool: Pool, private readonly send: Sender, private readonly opts: HandlerOptions = {}) {}

  async handle(e: PaymentEvent): Promise<{ sent: Channel[]; skipped: Channel[] }> {
    const channels = CHANNELS[e.eventType] ?? [];
    const text = TEMPLATES[e.eventType]?.(e) ?? "";
    const sent: Channel[] = [];
    const skipped: Channel[] = [];
    const failed: Channel[] = [];
    let lastErr: unknown;
    let inFlight = false;

    for (const ch of channels) {
      // Exclusive claim with a lease: take the row if it is new, FAILED, or SENDING with an expired lease.
      const claim = await this.pool.query(
        `INSERT INTO notifications.deliveries (outbox_id, channel) VALUES ($1,$2)
         ON CONFLICT (outbox_id, channel) DO UPDATE SET status='SENDING', updated_at = now()
         WHERE notifications.deliveries.status = 'FAILED'
            OR (notifications.deliveries.status = 'SENDING' AND notifications.deliveries.updated_at < now() - make_interval(secs => $3))
         RETURNING status`, [e.outboxId, ch, (this.opts.leaseMs ?? 30_000) / 1000]);
      if (claim.rowCount === 0) {
        const cur = (await this.pool.query("SELECT status FROM notifications.deliveries WHERE outbox_id=$1 AND channel=$2", [e.outboxId, ch])).rows[0];
        if (cur?.status === "SENT") { skipped.push(ch); duplicatesSuppressed.inc({ channel: ch }); continue; }
        inFlight = true; continue; // someone else is sending it right now
      }
      try {
        await this.withRetry(() => this.send(ch, e.userId, text, `${e.outboxId}:${ch}`), e.outboxId, ch);
        await this.pool.query("UPDATE notifications.deliveries SET status='SENT', updated_at=now() WHERE outbox_id=$1 AND channel=$2", [e.outboxId, ch]);
        sent.push(ch);
        delivered.inc({ channel: ch });
      } catch (err) {
        await this.pool.query("UPDATE notifications.deliveries SET status='FAILED', updated_at=now() WHERE outbox_id=$1 AND channel=$2", [e.outboxId, ch]);
        failed.push(ch); lastErr = err;
      }
    }
    if (failed.length) throw new DeadLetter(failed, lastErr);
    if (inFlight) throw new InFlight();
    return { sent, skipped };
  }

  private async withRetry(fn: () => Promise<void>, outboxId: number, ch: string): Promise<void> {
    const max = this.opts.maxAttempts ?? 4;
    const base = this.opts.backoffMs ?? 100;
    for (let attempt = 1; ; attempt++) {
      try { await fn(); return; }
      catch (err) {
        await this.pool.query("UPDATE notifications.deliveries SET attempts = attempts + 1 WHERE outbox_id=$1 AND channel=$2", [outboxId, ch]);
        if (attempt >= max) throw err;
        // exponential backoff with full jitter, so retries from many messages do not synchronise
        await new Promise((r) => setTimeout(r, Math.random() * base * 2 ** (attempt - 1)));
      }
    }
  }
}
