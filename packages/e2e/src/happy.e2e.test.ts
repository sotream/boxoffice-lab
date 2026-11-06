import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkInvariants, waitQuiescent } from "./invariants";
import { runLoad } from "./load";
import { Stack } from "./stack";

const SEATS = 100;
const USERS = 300;
let stack: Stack;

beforeAll(async () => {
  stack = await Stack.start({ tag: "happy", seats: SEATS, pspLatencyMs: 40, pspFailRate: 0.2, debugLogs: true });
}, 90_000);
afterAll(async () => { await stack?.stop(); }, 60_000);

describe("scenario 1: flash sale, no faults", () => {
  it(`${USERS} users, ${SEATS} seats: every system invariant holds end to end`, async () => {
    const load = await runLoad({ seed: 1001, users: USERS, seats: SEATS, gateway: stack.urls.gateway, paymentsUrl: stack.urls.payments, concurrency: USERS }, stack.runId);
    console.log("load:", JSON.stringify(Object.fromEntries(load.stats)), load.records.filter((r) => r.error).slice(0, 5).map((r) => r.error), load.records.filter((r) => r.error).length);
    const paid = load.records.filter((r) => r.payStatus !== undefined).length;
    let quiet: string;
    try { quiet = await waitQuiescent(stack, paid, 25_000); } catch (e) { console.log("DEBUG seen", stack.bridge.seen.length, "\nNOTIF", stack.log("notifications").slice(-1500), "\nPAY", stack.log("payments").slice(-800)); throw e; }
    await stack.waitUntil(async () => stack.bridge.pending === 0, 15_000); // late duplicates have been re-sent ...
    await new Promise((r) => setTimeout(r, 1500));                          // ... and consumed; the log syncer has caught up
    const sends = await stack.counter(stack.opsUrl, "notifications_delivered_total");
    const suppressed = await stack.counter(stack.opsUrl, "notifications_duplicate_suppressed_total");
    const report = await checkInvariants(stack, load, { seats: SEATS, notificationSends: sends, notificationSuppressed: suppressed });
    console.log("happy:", quiet, JSON.stringify(report.summary));

    expect(report.violations.join("\n")).toBe("");
    // the scenario really exercised the interesting paths
    const s = report.summary as Record<string, number>;
    expect(s.confirmed).toBeGreaterThan(20);
    expect(s.failed).toBeGreaterThan(5);       // the PSP declined some charges
    expect(s.refunded).toBeGreaterThan(0);     // cheaters paid for seats they did not hold: charged, then compensated
    expect(s.kafkaDuplicates).toBeGreaterThan(5);     // the broker really delivered duplicates, and every one was suppressed
    expect(s.seatsSold).toBeLessThanOrEqual(SEATS);
    expect(load.records.some((r) => r.twin)).toBe(true); // double submits happened
    // no 5xx anywhere on the way
    const fiveXX = [...load.stats].filter(([k]) => /:5\d\d$/.test(k));
    expect(fiveXX).toEqual([]);
    expect(load.retryAfterMissing).toBe(0);

    // (f) continued: the client's request ids are in the logs of the services on the path (gateway -> inventory, payments -> inventory)
    const gw = stack.log("gateway"), inv = stack.log("inventory"), pay = stack.log("payments");
    const missing: string[] = [];
    for (const r of load.records) {
      for (const h of r.holds) {
        if (!gw.includes(`"requestId":"${h.rid}"`)) missing.push(`gateway log lacks hold ${h.rid}`);
        if (!inv.includes(`"requestId":"${h.rid}"`)) missing.push(`inventory log lacks hold ${h.rid}`);
      }
      if (r.payStatus && r.payStatus !== "FAILED") {
        if (!pay.includes(`"requestId":"${r.payRid}"`)) missing.push(`payments log lacks ${r.payRid}`);
        if (!inv.includes(`"requestId":"${r.payRid}"`)) missing.push(`inventory log lacks the confirm of ${r.payRid}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
