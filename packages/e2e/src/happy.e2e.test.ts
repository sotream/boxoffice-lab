import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkInvariants, waitQuiescent } from "./invariants";
import { runLoad } from "./load";
import { signAdmission } from "@boxoffice/admission";
import { signInternalRequest } from "@boxoffice/platform";
import { INTERNAL_TOKEN, SECRET, Stack } from "./stack";

const SEATS = 100;
const USERS = 300;
let stack: Stack;

beforeAll(async () => {
  stack = await Stack.start({ tag: "happy", seats: SEATS, pspLatencyMs: 40, pspFailRate: 0.2, debugLogs: true });
}, 90_000);
afterAll(async () => { await stack?.stop(); }, 60_000);

let load: Awaited<ReturnType<typeof runLoad>>;

describe("scenario 1: flash sale, no faults", () => {
  it(`${USERS} users, ${SEATS} seats: every system invariant holds end to end`, async () => {
    load = await runLoad({ seed: 1001, users: USERS, seats: SEATS, gateway: stack.urls.gateway, concurrency: USERS }, stack.runId);
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
    // cheaters pay (as themselves) for seats they do not hold: payments asks inventory BEFORE the charge (ADR 007), so they end FAILED
    // with the card untouched. Under load that question can time out; the payment then goes on unchecked and the confirm refuses it, so
    // REFUNDED is still possible for a cheater, but never a confirmed seat, and refunds can only be cheaters'.
    const cheaterIds = load.records.filter((r) => r.kind === "cheater").map((r) => r.userId);
    expect(cheaterIds.length).toBeGreaterThan(0);
    const cheaterRows = await stack.q<{ user_id: string; status: string }>("SELECT user_id, status FROM payments.payments WHERE user_id = ANY($1)", [cheaterIds]);
    expect(cheaterRows.length).toBeGreaterThan(0);
    expect(cheaterRows.filter((r) => r.status !== "FAILED" && r.status !== "REFUNDED").map((r) => `${r.user_id}:${r.status}`), "a cheater ended with something other than FAILED or REFUNDED").toEqual([]);
    expect(cheaterRows.filter((r) => r.status === "FAILED").length, "most cheaters are stopped before the charge").toBeGreaterThan(0);
    expect(s.refunded, "refunds only for cheaters whose check timed out").toBeLessThanOrEqual(cheaterRows.length);
    expect(s.impostors).toBeGreaterThan(0);    // impostors put another user's id in the pay body ...
    expect(s.impostors403).toBe(s.impostors);  // ... and every one was refused by the gateway; (g) shows that nothing was charged
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

describe("scenario 1b: the boundary of payments, after the sale", () => {
  const payBody = (userId: string, over: Record<string, unknown> = {}) => JSON.stringify({ eventId: 1, userId, seatIds: [1], ...over });
  const post = (url: string, headers: Record<string, string>, body: string) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  const count = async () => Number((await stack.q<{ n: string }>("SELECT count(*) n FROM payments.payments"))[0].n);

  it("payments refuses callers without the internal token and prices the order itself; a replayed key of another user is an independent payment that never reveals the owner's; nothing is written by the refused calls", async () => {
    const before = await count();
    const direct = `${stack.urls.payments}/payments`;
    const key = { "idempotency-key": "e2e-boundary-1" };
    // not reachable without the credential, whatever the body is
    expect((await post(direct, key, payBody("mallory"))).status).toBe(401);
    const signed = (body: string, secret = INTERNAL_TOKEN, now = Date.now()) => ({ ...key, "x-internal-auth": signInternalRequest(secret, "POST", "/payments", body, now) });
    expect((await post(direct, signed(payBody("mallory"), "guess"), payBody("mallory"))).status).toBe(401);
    // the secret is never on the wire, and a signature neither survives another body nor the clock skew
    expect((await post(direct, signed(payBody("mallory")), payBody("mallory", { seatIds: [1, 2] }))).status).toBe(401);
    expect((await post(direct, signed(payBody("mallory"), INTERNAL_TOKEN, Date.now() - 120_000), payBody("mallory"))).status).toBe(401);
    expect((await post(direct, key, "{not json")).status).toBe(401);
    // with the credential a tampered price is refused (the amount is computed from the seats)
    expect((await post(direct, signed(payBody("mallory", { amountCents: 1 })), payBody("mallory", { amountCents: 1 }))).status).toBe(400);

    // through the gateway: no token, a token of another event, and a body for somebody else are all refused before payments is called
    const gw = `${stack.urls.gateway}/events/1/pay`;
    const tok = signAdmission("mallory", 1, 60, SECRET);
    expect((await post(gw, key, payBody("mallory"))).status).toBe(403);
    expect((await post(gw, { ...key, "x-admission": signAdmission("mallory", 2, 60, SECRET) }, payBody("mallory"))).status).toBe(403);
    expect((await post(gw, { ...key, "x-admission": tok }, payBody("someone-else"))).status).toBe(403);
    expect((await post(gw, { ...key, "x-admission": tok }, payBody("mallory", { eventId: 2 }))).status).toBe(400);
    expect((await post(gw, { "x-admission": tok }, payBody("mallory"))).status).toBe(400); // no Idempotency-Key
    expect((await post(gw, { ...key, "x-admission": tok }, payBody("mallory", { amountCents: 1 }))).status).toBe(400); // payments' price check, relayed

    // every call above was refused: nothing was written
    expect(await count()).toBe(before);

    // replaying the client key of a payment somebody else made: the key is scoped by user, so this is mallory's own payment
    // (for seats she does not hold, hence not confirmed), never the victim's id or status, and it cannot block the victim
    const victim = load.records.find((r) => r.payStatus === "CONFIRMED")!;
    const replay = await post(gw, { "idempotency-key": victim.payKey, "x-admission": tok }, payBody("mallory", { seatIds: victim.seats.slice(0, 8) }));
    expect([200, 202]).toContain(replay.status);
    const mine = await replay.json();
    expect(mine.paymentId).not.toBe(victim.paymentId);
    expect(mine.status).not.toBe("CONFIRMED");
    expect(await count()).toBe(before + 1);
    // the owner replaying their own key still gets the stored result
    const owner = await post(gw, { "idempotency-key": victim.payKey, "x-admission": signAdmission(victim.userId, 1, 60, SECRET) }, payBody(victim.userId, { seatIds: victim.seats.slice(0, 8) }));
    expect(owner.status).toBe(200);
    expect(await owner.json()).toMatchObject({ status: "CONFIRMED", paymentId: victim.paymentId, inProgress: false });

    expect(await count()).toBe(before + 1);
  });
});
