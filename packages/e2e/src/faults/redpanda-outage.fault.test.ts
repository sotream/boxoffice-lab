import { afterEach, describe, expect, it } from "vitest";
import { runLoad } from "../load";
import { count, ReadySampler, serverErrors, settleAndCheck, startWorld, stopWorld, type World } from "./world";

const SEATS = 80, USERS = 200, OUTAGE_MS = 15_000;
let w: World | undefined;
afterEach(async () => { await stopWorld(w); w = undefined; }, 120_000);

describe("fault 3: Redpanda stopped for 15 s in the middle of the sale", () => {
  it("the outbox absorbs it (sales keep working), the relay publishes the backlog once and in order, notifications deliver each event once, nothing is dead-lettered", async () => {
    // slow admission: the sale is still going on while the broker is away
    w = await startWorld("rpoutage", { seats: SEATS, pspLatencyMs: 100, pspFailRate: 0.1, admitPerSecond: 8, seed: 4301 });
    const s = w.stack;
    const sampler = new ReadySampler({ payments: s.urls.payments });
    sampler.start();
    const load = runLoad({ seed: 4301, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 150_000 }, s.runId);

    await s.waitUntil(async () => (await count(s, "payments.outbox")) >= 12 && (await count(s, "notifications.deliveries")) >= 4, 60_000, 50);
    await w.infra.kafka.stop();
    const t0 = Date.now();
    const inFlightIds = (await s.q<{ id: string }>(`SELECT id::text FROM payments.outbox WHERE published_at IS NULL`)).map((r) => Number(r.id));
    const startOutage = { payments: await count(s, "payments.payments"), published: await count(s, "payments.outbox WHERE published_at IS NOT NULL"), backlog: await count(s, "payments.outbox WHERE published_at IS NULL") };
    await new Promise((r) => setTimeout(r, OUTAGE_MS));
    // the backlog grew, nothing was published, the sale itself went on
    const endOutage = { payments: await count(s, "payments.payments"), published: await count(s, "payments.outbox WHERE published_at IS NOT NULL"), backlog: await count(s, "payments.outbox WHERE published_at IS NULL") };
    const backlogIds = (await s.q<{ id: string }>(`SELECT id::text FROM payments.outbox WHERE published_at IS NULL ORDER BY id`)).map((r) => Number(r.id));
    const gauge = await s.counter(s.urls.payments, "payments_outbox_backlog");
    const relayErrors = (await s.counter(s.urls.payments, "payments_outbox_relay_errors_total")) ?? 0;
    const oldest = await s.counter(s.urls.payments, "payments_outbox_oldest_unpublished_age_seconds");
    const readyDuring = sampler.between("payments", t0 + 3000, Date.now());
    const aliveDuring = s.alive("payments");
    const readyBody = await (await fetch(`${s.urls.payments}/readyz`)).json() as { status: string; checks: Record<string, { ok: boolean }> };
    const t1 = Date.now();
    expect(aliveDuring).toBe(true);
    // while the broker was away: nothing was published, the backlog grew, new payments kept being accepted and completed
    expect(endOutage.published, "rows marked published during the outage").toBe(startOutage.published);
    expect(endOutage.backlog).toBeGreaterThan(startOutage.backlog);
    expect(endOutage.payments).toBeGreaterThan(startOutage.payments);
    expect(backlogIds.length).toBe(endOutage.backlog);
    // the metrics tell the operator the same
    expect(gauge).toBe(endOutage.backlog);
    expect(relayErrors, "relay errors during the outage").toBeGreaterThan(0);
    expect(oldest ?? 0).toBeGreaterThan(5);
    // kafka is reported, not critical: payments stays ready, and says why it is degraded
    expect(new Set(readyDuring)).toEqual(new Set([200]));
    expect(readyBody.checks.kafka?.ok).toBe(false);
    await w.infra.kafka.start();

    const result = await load;
    const { report, quiet } = await settleAndCheck(w, result, { seats: SEATS, exactlyOnceOnBroker: { exceptIds: inFlightIds }, backlogIds, quiescentMs: 120_000 });
    const backlogAfter = await s.counter(s.urls.payments, "payments_outbox_backlog");
    const published = (await s.counter(s.urls.payments, "payments_outbox_published_total")) ?? 0;
    sampler.stop();
    console.log("redpanda outage:", quiet, JSON.stringify({ inFlightIds, startOutage, endOutage, gauge, oldest, relayErrors, backlogAfter, published, outageMs: t1 - t0, errors: serverErrors(result), ...report.summary }));

    // the sale was not hurt: payments did not turn a broker outage into errors for clients
    expect(serverErrors(result)).toEqual([]);
    // after recovery: the backlog is published, once, in order (checked inside the invariants), and the gauge says 0
    expect(backlogAfter).toBe(0);
    expect(published).toBeGreaterThanOrEqual(backlogIds.length);
    expect(report.violations.join("\n")).toBe("");
    expect((report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
  }, 280_000);
});
