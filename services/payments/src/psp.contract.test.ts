import { describe, expect, it } from "vitest";
import { FakePsp, Psp } from "./psp";
import { pspContract, pspContractCases } from "./psp.contract";

pspContract("FakePsp", () => {
  const psp = new FakePsp(5); // latency makes the concurrent case really concurrent
  return { psp, effectiveCharges: () => psp.charges.size, effectiveRefunds: () => psp.refundsApplied };
});

/** A provider that does NOT dedupe by key: the contract must catch it. */
class NaivePsp implements Psp {
  charged = 0; refunded = 0;
  async charge(_key: string, _amount: number) { await new Promise((r) => setTimeout(r, 5)); this.charged++; return { ok: true, chargeId: `n_${this.charged}` }; }
  async refund(_chargeId: string, _key: string) { this.refunded++; }
}

describe("the contract suite has teeth", () => {
  it("a PSP without key dedupe fails the idempotency cases and the unknown-refund case", async () => {
    const cases = pspContractCases(() => { const psp = new NaivePsp(); return { psp, effectiveCharges: () => psp.charged, effectiveRefunds: () => psp.refunded }; });
    const failed: string[] = [];
    for (const c of cases) { try { await c.run(); } catch { failed.push(c.name); } }
    expect(failed).toEqual(expect.arrayContaining([
      "charge is idempotent by key: same key returns the same charge id",
      "concurrent charges with the same key charge once",
      "refund is idempotent by key, sequentially and concurrently",
      "refund of an unknown charge fails loudly",
    ]));
  });
});
