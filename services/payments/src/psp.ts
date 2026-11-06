/** Fake payment provider. Idempotent by key, like Stripe: the same key never charges twice. */
export interface Psp {
  charge(idempotencyKey: string, amountCents: number): Promise<{ ok: boolean; chargeId?: string }>;
  /** Must be idempotent by key: a retry after a crash between refund and state change must not refund twice.
   *  Must reject (loudly) for a charge id it never issued. Verify any adapter with pspContract (psp.contract.ts). */
  refund(chargeId: string, idempotencyKey: string): Promise<void>;
}

export class FakePsp implements Psp {
  readonly charges = new Map<string, string>();
  readonly refunds = new Set<string>();
  private readonly refundKeys = new Set<string>();
  /** Effective money moved, for conservation checks in tests. */
  readonly chargedCentsById = new Map<string, number>();
  readonly refundsPerCharge = new Map<string, number>();
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
    this.chargedCentsById.set(id, _amount);
    return { ok: true, chargeId: id };
  }

  async refund(chargeId: string, key: string) {
    this.refundCalls++;
    if (![...this.charges.values()].includes(chargeId)) throw new Error(`unknown charge ${chargeId}`);
    if (this.refundKeys.has(key)) return;
    this.refundKeys.add(key);
    this.refundsApplied++;
    this.refunds.add(chargeId);
    this.refundsPerCharge.set(chargeId, (this.refundsPerCharge.get(chargeId) ?? 0) + 1);
  }
}

