/** Fake payment provider. Idempotent by key, like Stripe: the same key never charges twice. */
export interface Psp {
  charge(idempotencyKey: string, amountCents: number): Promise<{ ok: boolean; chargeId?: string }>;
  refund(chargeId: string): Promise<void>;
}

export class FakePsp implements Psp {
  readonly charges = new Map<string, string>();
  readonly refunds = new Set<string>();
  chargeCalls = 0;
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

  async refund(chargeId: string) { this.refunds.add(chargeId); }
}
