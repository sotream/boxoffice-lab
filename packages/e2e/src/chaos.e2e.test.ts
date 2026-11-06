import { afterEach, describe, expect, it } from "vitest";
import { checkInvariants, waitQuiescent } from "./invariants";
import { runLoad } from "./load";
import { Stack } from "./stack";

const SEATS = 80;
const USERS = 250;
let stack: Stack | undefined;
afterEach(async () => { await stack?.stop(); stack = undefined; }, 60_000);

const count = async (s: Stack, table: string) => Number((await s.q<{ n: string }>(`SELECT count(*) n FROM ${table}`))[0].n);

/**
 * Same load as scenario 1, with two crashes in the middle of it:
 *   1. kill -9 payments while sagas are in flight (PENDING/CHARGED rows, uncommitted relay batches), restart it on the same port;
 *   2. kill -9 the notifications consumer while it is delivering, restart it (same consumer group).
 * Recovery is only allowed to use the product's own mechanisms: client retries with the same Idempotency-Key, the sweeper, the outbox
 * relay, consumer group redelivery and the dedup key. Then the same invariants as scenario 1 must hold.
 */
async function chaosRun(seed: number) {
  stack = await Stack.start({ tag: `chaos${seed}`, seats: SEATS, pspLatencyMs: 250, pspFailRate: 0.15, admitPerSecond: 150, seed });
  const s = stack;
  const load = runLoad({ seed, users: USERS, seats: SEATS, gateway: s.urls.gateway, paymentsUrl: s.urls.payments, concurrency: USERS, deadlineMs: 60_000 }, s.runId);

  // ---- crash 1: payments, mid-saga ----
  await s.waitUntil(async () => (await count(s, "payments.payments")) >= 25, 40_000, 20);
  const open = Number((await s.q<{ n: string }>(`SELECT count(*) n FROM payments.payments WHERE status NOT IN ('CONFIRMED','REFUNDED','FAILED')`))[0].n);
  const unpublished = Number((await s.q<{ n: string }>(`SELECT count(*) n FROM payments.outbox WHERE published_at IS NULL`))[0].n);
  await s.kill("payments");
  const paymentsExit = await s.procs.get("payments")!.exited;
  await new Promise((r) => setTimeout(r, 2000)); // clients see connection refused meanwhile and retry with the same key
  await s.start("payments");

  // ---- crash 2: notifications, mid-delivery ----
  await s.waitUntil(async () => (await count(s, "notifications.deliveries")) >= 10, 60_000, 20);
  const deliveriesAtKill = await count(s, "notifications.deliveries");
  await s.kill("notifications");
  const notifExit = await s.procs.get("notifications")!.exited;
  await new Promise((r) => setTimeout(r, 1000));
  await s.start("notifications");

  const result = await load;
  const paid = result.records.filter((r) => r.payStatus !== undefined).length;
  const quiet = await waitQuiescent(s, paid, 45_000);
  await s.waitUntil(async () => s.bridge.pending === 0, 15_000);
  await new Promise((r) => setTimeout(r, 2000));
  await waitQuiescent(s, paid, 30_000);
  const report = await checkInvariants(s, result, { seats: SEATS });
  const sweepLogs = s.log("payments");
  console.log(`chaos seed ${seed}:`, quiet, JSON.stringify({ openAtKill: open, unpublishedAtKill: unpublished, deliveriesAtKill, ...report.summary }));
  return { report, open, unpublished, paymentsExit, notifExit, deliveriesAtKill, result, sweepLogs };
}

describe("scenario 2: kill -9 of payments and of the notifications consumer during the sale", () => {
  for (const seed of [2001, 2002]) {
    it(`seed ${seed}: sagas finish, the outbox republishes, dedup holds, every invariant still holds`, async () => {
      const c = await chaosRun(seed);
      expect(c.paymentsExit.signal).toBe("SIGKILL");
      expect(c.notifExit.signal).toBe("SIGKILL");
      expect(c.report.violations.join("\n")).toBe("");
      // the crash really hit work in flight (otherwise the run proves nothing about recovery)
      expect(c.open).toBeGreaterThan(0);
      expect(c.deliveriesAtKill).toBeGreaterThan(0);
      const s = c.report.summary as Record<string, number>;
      expect(s.confirmed).toBeGreaterThan(10);
      expect(s.deliveries).toBeGreaterThan(c.deliveriesAtKill);
    }, 170_000);
  }
});
