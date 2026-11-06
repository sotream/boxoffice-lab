/** Fake payment provider. Idempotent by key, like Stripe: the same key never charges twice. */
export interface Psp {
  charge(idempotencyKey: string, amountCents: number): Promise<{ ok: boolean; chargeId?: string }>;
  /** Must be idempotent by key: a retry after a crash between refund and state change must not refund twice. */
  refund(chargeId: string, idempotencyKey: string): Promise<void>;
}

export class FakePsp implements Psp {
  readonly charges = new Map<string, string>();
  readonly refunds = new Set<string>();
  private readonly refundKeys = new Set<string>();
  chargeCalls = 0;
  refundCalls = 0;
  /** Refunds actually applied (not deduplicated by key). Money returned twice shows up here. */
  refundsApplied = 0;
  constructor(public latencyMs = 0, private readonly failRate = 0) {}

  async charge(key: string, _amount: number) {
    this.chargeCalls++;
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const existing = this.charges.get(key);
    if (existing) return { ok: true, chargeId: existing };
    if (Math.random() < this.failRate) return { ok: false };
    const id = `ch_${this.charges.size + 1}`;
    this.charges.set(key, id);
    return { ok: true, chargeId: id };
  }

  async refund(chargeId: string, key: string) {
    this.refundCalls++;
    if (this.refundKeys.has(key)) return;
    this.refundKeys.add(key);
    this.refundsApplied++;
    this.refunds.add(chargeId);
  }
}
