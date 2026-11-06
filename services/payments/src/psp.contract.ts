import { describe, expect, it } from "vitest";
import { Psp } from "./psp";

/** What a contract run needs: the adapter, and (optionally) counters of EFFECTIVE side effects at the provider. */
export interface PspUnderTest {
  psp: Psp;
  effectiveCharges?: () => number;
  effectiveRefunds?: () => number;
}

/**
 * Contract every PSP adapter must pass. The saga relies on these properties for safety (ADR 005):
 * a retry, a sweeper and a request path may all call the same operation with the same key.
 * An adapter over a provider that does not dedupe by key must dedupe itself (e.g. a key -> result table) to pass.
 * Usage: `pspContract("StripeAdapter", () => ({ psp: new StripeAdapter(...) }))` in a test file.
 */
export interface ContractCase { name: string; run: () => Promise<void> }

export function pspContractCases(makeFactory: () => PspUnderTest | Promise<PspUnderTest>): ContractCase[] {
  const cases: ContractCase[] = [];
  const it = (name: string, run: () => Promise<void>) => { cases.push({ name, run }); };
  {
    it("charge is idempotent by key: same key returns the same charge id", async () => {
      const t = await makeFactory();
      const a = await t.psp.charge("key-a", 1000);
      const b = await t.psp.charge("key-a", 1000);
      expect(a.ok).toBe(true);
      expect(b).toEqual(a);
      expect(a.chargeId).toBeTruthy();
      if (t.effectiveCharges) expect(t.effectiveCharges()).toBe(1);
    });

    it("different keys make different charges", async () => {
      const t = await makeFactory();
      const a = await t.psp.charge("key-1", 1000);
      const b = await t.psp.charge("key-2", 1000);
      expect(a.chargeId).not.toBe(b.chargeId);
      if (t.effectiveCharges) expect(t.effectiveCharges()).toBe(2);
    });

    it("concurrent charges with the same key charge once", async () => {
      const t = await makeFactory();
      const rs = await Promise.all(Array.from({ length: 20 }, () => t.psp.charge("key-c", 1000)));
      expect(new Set(rs.map((r) => r.chargeId)).size).toBe(1);
      expect(rs.every((r) => r.ok)).toBe(true);
      if (t.effectiveCharges) expect(t.effectiveCharges()).toBe(1);
    });

    it("refund is idempotent by key, sequentially and concurrently", async () => {
      const t = await makeFactory();
      const c = await t.psp.charge("key-r", 1000);
      await t.psp.refund(c.chargeId!, "refund:key-r");
      await t.psp.refund(c.chargeId!, "refund:key-r");
      await Promise.all(Array.from({ length: 10 }, () => t.psp.refund(c.chargeId!, "refund:key-r")));
      if (t.effectiveRefunds) expect(t.effectiveRefunds()).toBe(1);
    });

    it("refund of an unknown charge fails loudly", async () => {
      const t = await makeFactory();
      await expect(t.psp.refund("ch_does_not_exist", "refund:nope")).rejects.toThrow();
      if (t.effectiveRefunds) expect(t.effectiveRefunds()).toBe(0);
    });
  }
  return cases;
}

export function pspContract(name: string, makeFactory: () => PspUnderTest | Promise<PspUnderTest>): void {
  describe(`PSP contract: ${name}`, () => {
    for (const c of pspContractCases(makeFactory)) it(c.name, c.run);
  });
}
