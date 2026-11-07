import { EVENT, LoadResult, SEAT_PRICE_CENTS, UserRecord } from "./load";
import { Stack } from "./stack";

const FINAL = ["CONFIRMED", "REFUNDED", "FAILED"];
const EVENT_OF: Record<string, string> = { CONFIRMED: "payment.confirmed", REFUNDED: "payment.refunded", FAILED: "payment.failed" };
const CHANNELS: Record<string, string[]> = { "payment.confirmed": ["email", "push"], "payment.refunded": ["email", "push"], "payment.failed": ["push"] };

interface PaymentRow { id: string; idempotency_key: string; user_id: string; seat_ids: number[]; amount_cents: number; status: string; trace: { requestId?: string } | null }
interface OutboxRow { id: string; payload: { eventType: string; paymentId: number; userId: string; seatIds: number[]; amountCents: number; trace?: { requestId?: string } }; published_at: string | null }
interface SeatRow { seat_id: number; status: string; held_by: string | null }
interface DeliveryRow { outbox_id: string; channel: string; status: string }

/** Poll (never sleep blindly) until every payment is terminal, the outbox is drained and every notification is SENT. */
export async function waitQuiescent(stack: Stack, expectedPayments: number, timeoutMs: number): Promise<string> {
  let last = "";
  try {
    await stack.waitUntil(async () => {
      const [p] = await stack.q<{ n: string; open: string }>(`SELECT count(*) n, count(*) FILTER (WHERE status <> ALL($1)) open FROM payments.payments`, [FINAL]);
      const [o] = await stack.q<{ n: string; unpub: string }>(`SELECT count(*) n, count(*) FILTER (WHERE published_at IS NULL) unpub FROM payments.outbox`);
      const [d] = await stack.q<{ n: string; sent: string; expected: string }>(
        `SELECT (SELECT count(*) FROM notifications.deliveries) n,
                (SELECT count(*) FROM notifications.deliveries WHERE status='SENT') sent,
                (SELECT coalesce(sum(CASE payload->>'eventType' WHEN 'payment.failed' THEN 1 ELSE 2 END),0) FROM payments.outbox) expected`);
      last = `payments=${p.n}/${expectedPayments} open=${p.open} outbox=${o.n} unpublished=${o.unpub} deliveries=${d.n} sent=${d.sent} expected=${d.expected}`;
      return Number(p.n) === expectedPayments && Number(p.open) === 0 && Number(o.n) === expectedPayments && Number(o.unpub) === 0 && Number(d.sent) === Number(d.expected) && Number(d.n) === Number(d.expected);
    }, timeoutMs, 250);
  } catch { throw new Error(`not quiescent after ${timeoutMs} ms: ${last}`); }
  return last;
}

export interface Report { violations: string[]; summary: Record<string, unknown> }

/**
 * Reads the databases directly and checks the end-to-end invariants against what the clients were told. Returns every violation
 * (never throws on the first), so a failing run shows the whole picture. Letters follow docs/e2e.md.
 */
export interface CheckOptions {
  seats: number; notificationSends?: number; notificationSuppressed?: number;
  /** Hold duration of the run in seconds (default 600): a seat may be granted again after the first hold's time is over, never before. */
  holdSeconds?: number;
  /** Fault suite: a duplicate on the broker can only come from the relay itself (nothing injects any); when true, every outbox row must have exactly one copy. */
  exactlyOnceOnBroker?: boolean | { /** Rows that were in flight when the broker went away: the relay may legitimately have sent them twice (ack lost, row not marked). */ exceptIds: number[] };
  /** Outbox ids that were unpublished and committed at a known moment: they must appear on the topic in increasing id order. */
  backlogIds?: number[];
}

export async function checkInvariants(stack: Stack, load: LoadResult, opts: CheckOptions): Promise<Report> {
  const v: string[] = [];
  await stack.bridge.sync?.(); // private broker: read what is on the topic now
  const seats = await stack.q<SeatRow>(`SELECT seat_id, status, held_by FROM seats WHERE event_id=$1 ORDER BY seat_id`, [EVENT]);
  const pays = await stack.q<PaymentRow>(`SELECT id::text, idempotency_key, user_id, seat_ids, amount_cents, status, trace FROM payments.payments ORDER BY id`);
  const outbox = await stack.q<OutboxRow>(`SELECT id::text, payload, published_at FROM payments.outbox ORDER BY id`);
  const deliveries = await stack.q<DeliveryRow>(`SELECT outbox_id::text, channel, status FROM notifications.deliveries`);
  const byUser = new Map<string, UserRecord>(load.records.map((r) => [r.userId, r]));
  const payByKey = new Map(pays.map((p) => [p.idempotency_key, p]));
  const seatRow = new Map(seats.map((s) => [s.seat_id, s]));

  // ---- (a) no seat sold or held to two users --------------------------------------------------------------------------------
  // A second grant is legitimate only after the first hold ran out: the first hold lasts until (commit time + H) >= (request start + H), and the
  // second grant is committed before its answer arrives, so answer(2nd) < request start(1st) + H proves an overlap. H defaults to 600 s.
  const holdMs = (opts.holdSeconds ?? 600) * 1000;
  let regrants = 0;
  for (const [seat, gl] of load.grantsTimed) {
    for (let i = 1; i < gl.length; i++) {
      if (gl[i].end < gl[i - 1].start + holdMs) v.push(`(a) seat ${seat} was granted (HTTP 200) to ${gl.length} users: ${gl.map((g) => g.user).join(",")} (the second grant arrived ${gl[i - 1].start + holdMs - gl[i].end} ms before the first hold could have expired)`);
      else regrants++;
    }
  }
  let lostAnswerHolds = 0;
  if (seats.length !== opts.seats) v.push(`(a) seat table has ${seats.length} rows, expected ${opts.seats}`);
  const confirmedSeatOwner = new Map<number, string>();
  for (const p of pays.filter((x) => x.status === "CONFIRMED")) for (const s of p.seat_ids) {
    if (confirmedSeatOwner.has(s)) v.push(`(a) seat ${s} is in two CONFIRMED payments (${confirmedSeatOwner.get(s)} and ${p.user_id})`);
    confirmedSeatOwner.set(s, p.user_id);
  }
  // exact reference model: every seat must be exactly what the grants and the CONFIRMED payments imply
  for (const s of seats) {
    const winner = (load.grantsTimed.get(s.seat_id) ?? []).at(-1)?.user; // the last grantee: earlier holds had expired
    const want = winner !== undefined && confirmedSeatOwner.get(s.seat_id) === winner ? "sold" : winner !== undefined ? "held" : "free";
    // a hold whose answer was lost (crash, timeout) may exist in the database without the client knowing: that user is allowed to hold the seat
    if (s.status === "held" && s.held_by !== null && load.ambiguous.get(s.seat_id)?.has(s.held_by) && s.held_by !== winner) { lostAnswerHolds++; continue; }
    if (s.status !== want || s.held_by !== (winner ?? null)) {
      v.push(`(a/b) seat ${s.seat_id}: db says ${s.status}/${s.held_by}, model says ${want}/${winner ?? "-"} (CONFIRMED payment owner: ${confirmedSeatOwner.get(s.seat_id) ?? "none"})`);
    }
  }

  // ---- (b) seats sold == union of seats of CONFIRMED payments, exactly ------------------------------------------------------
  const sold = new Set(seats.filter((s) => s.status === "sold").map((s) => s.seat_id));
  for (const s of sold) if (!confirmedSeatOwner.has(s)) v.push(`(b) seat ${s} is sold but no CONFIRMED payment covers it`);
  for (const s of confirmedSeatOwner.keys()) if (!sold.has(s)) v.push(`(b) seat ${s} is in a CONFIRMED payment but not sold`);
  for (const p of pays.filter((x) => x.status === "CONFIRMED")) for (const s of p.seat_ids) {
    if (seatRow.get(s)?.held_by !== p.user_id) v.push(`(b) CONFIRMED payment ${p.id} of ${p.user_id} covers seat ${s}, which belongs to ${seatRow.get(s)?.held_by}`);
  }
  // ADR 005 residual risk, reported explicitly: a REFUNDED payment whose seats ended up sold to its user
  for (const p of pays.filter((x) => x.status === "REFUNDED")) for (const s of p.seat_ids) {
    const row = seatRow.get(s);
    if (row?.status === "sold" && row.held_by === p.user_id) v.push(`(b/ADR005) REFUNDED payment ${p.id}: seat ${s} is sold to ${p.user_id} (customer has the seats AND the money back)`);
  }

  // ---- what the clients were told == what is stored ---------------------------------------------------------------------------
  for (const r of load.records) {
    if (r.error) v.push(`client ${r.userId} did not finish: ${r.error}`);
    if (r.payStatus === undefined) continue;
    const p = payByKey.get(r.payKey);
    if (!p) { v.push(`client ${r.userId} saw ${r.payStatus} but no payment row exists`); continue; }
    if (p.status !== r.payStatus) v.push(`client ${r.userId} saw ${r.payStatus}, the row says ${p.status}`);
    if (Number(p.id) !== r.paymentId) v.push(`client ${r.userId}: paymentId ${r.paymentId} != row ${p.id}`);
    if (r.twin && (r.twin.status !== r.payStatus || r.twin.paymentId !== r.paymentId)) v.push(`idempotency: the double submit of ${r.userId} gave ${JSON.stringify(r.twin)} and ${r.payStatus}/${r.paymentId}`);
  }
  // ---- (g) an admitted user cannot pay as somebody else: the gateway said 403 and nothing was charged -------------------------------
  const impostors = load.records.filter((r) => r.impostor);
  for (const r of impostors) {
    if (r.impostor!.status !== 403) v.push(`(g) impostor ${r.userId} put ${r.impostor!.victim} in the pay body and got ${r.impostor!.status}, expected 403`);
    if (payByKey.has(r.payKey)) v.push(`(g) impostor ${r.userId}: a payment row exists for its key although the gateway refused it`);
    if (pays.some((p) => p.user_id === r.userId)) v.push(`(g) impostor ${r.userId} has a payment row`);
  }
  const clientPayers = load.records.filter((r) => r.payStatus !== undefined).length;
  if (pays.length !== clientPayers) v.push(`${pays.length} payment rows but ${clientPayers} clients paid (one Idempotency-Key must give exactly one row)`);
  for (const p of pays) {
    if (!byUser.has(p.user_id)) v.push(`payment ${p.id} belongs to an unknown user ${p.user_id}`);
    if (!FINAL.includes(p.status)) v.push(`payment ${p.id} is not terminal: ${p.status}`);
  }

  // ---- (c) money conservation -------------------------------------------------------------------------------------------------
  // The fake PSP lives inside the payments process (memory only, lost on SIGKILL), so its ledger cannot be read from outside.
  // The check is made on what is durable: the payments table, the outbox events and what the clients were told.
  const total = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
  const rows = (st: string) => total(pays.filter((p) => p.status === st).map((p) => p.amount_cents));
  const ev = (t: string) => total(outbox.filter((o) => o.payload.eventType === t).map((o) => o.payload.amountCents));
  const confirmedSum = rows("CONFIRMED");
  const charged = ev("payment.confirmed") + ev("payment.refunded"); // money taken at the PSP: a FAILED payment was declined, nothing moved
  const refunded = ev("payment.refunded");
  if (charged - refunded !== confirmedSum) v.push(`(c) charges ${charged} - refunds ${refunded} != confirmed total ${confirmedSum}`);
  if (rows("REFUNDED") !== refunded) v.push(`(c) REFUNDED rows total ${rows("REFUNDED")} != refund events ${refunded}`);
  const clientConfirmed = total(load.records.filter((r) => r.payStatus === "CONFIRMED").map((r) => r.amountCents));
  if (clientConfirmed !== confirmedSum) v.push(`(c) clients were told CONFIRMED for ${clientConfirmed} cents, the ledger says ${confirmedSum}`);
  if (sold.size * SEAT_PRICE_CENTS !== confirmedSum) v.push(`(c) ${sold.size} sold seats x ${SEAT_PRICE_CENTS} != confirmed total ${confirmedSum}`);

  // ---- (d) exactly one terminal outbox event per payment, all published --------------------------------------------------------
  const outByPayment = new Map<number, OutboxRow[]>();
  for (const o of outbox) { const k = Number(o.payload.paymentId); (outByPayment.get(k) ?? outByPayment.set(k, []).get(k)!).push(o); } // paymentId is a JSON string on the wire (bigserial), compared as a number here
  for (const p of pays) {
    const os = outByPayment.get(Number(p.id)) ?? [];
    if (os.length !== 1) v.push(`(d) payment ${p.id} (${p.status}) has ${os.length} outbox events, expected exactly 1`);
    else if (os[0].payload.eventType !== EVENT_OF[p.status]) v.push(`(d) payment ${p.id} is ${p.status} but its event is ${os[0].payload.eventType}`);
    else if (os[0].payload.amountCents !== p.amount_cents || os[0].payload.userId !== p.user_id) v.push(`(d) payment ${p.id}: the event payload differs from the row`);
  }
  for (const pid of outByPayment.keys()) if (!pays.some((p) => Number(p.id) === pid)) v.push(`(d) outbox event for unknown payment ${pid}`);
  for (const o of outbox) if (!o.published_at) v.push(`(d) outbox ${o.id} was never published`);

  // ---- the broker carried every event (at-least-once duplicates are counted, not hidden) ---------------------------------------
  const seen = new Map<number, number>();
  for (const e of stack.bridge.seen) seen.set(e.outboxId, (seen.get(e.outboxId) ?? 0) + 1);
  for (const o of outbox) if (!seen.has(Number(o.id))) v.push(`(d/e) outbox ${o.id} is marked published but the broker never carried it`);
  const kafkaDuplicates = [...seen.values()].reduce((n, c) => n + (c - 1), 0);
  if (opts.exactlyOnceOnBroker) {
    const except = new Set(typeof opts.exactlyOnceOnBroker === "object" ? opts.exactlyOnceOnBroker.exceptIds : []);
    for (const [id, n] of seen) if (n > 1 && !except.has(id)) v.push(`(d) outbox ${id} reached the broker ${n} times`);
  }
  if (opts.backlogIds) {
    const order = stack.bridge.seen.map((e) => e.outboxId).filter((id, i, a) => a.indexOf(id) === i && opts.backlogIds!.includes(id));
    for (let i = 1; i < order.length; i++) if (order[i] < order[i - 1]) v.push(`(d) the backlog was published out of order: outbox ${order[i - 1]} before ${order[i]}`);
    if (order.length !== opts.backlogIds.length) v.push(`(d) ${opts.backlogIds.length} backlog rows, ${order.length} of them on the broker`);
  }
  const dlq = await stack.bridge.dlqSize();
  if (dlq !== 0) v.push(`(e) the dead-letter topic holds ${dlq} messages`);

  // ---- (e) notifications delivered == unique terminal events, no duplicates -----------------------------------------------------
  const expected = new Set<string>();
  for (const o of outbox) for (const ch of CHANNELS[o.payload.eventType] ?? []) expected.add(`${o.id}:${ch}`);
  const got = new Map<string, number>();
  for (const d of deliveries) {
    const k = `${d.outbox_id}:${d.channel}`;
    got.set(k, (got.get(k) ?? 0) + 1);
    if (d.status !== "SENT") v.push(`(e) delivery ${k} is ${d.status}`);
  }
  for (const k of expected) if (!got.has(k)) v.push(`(e) missing delivery ${k}`);
  for (const [k, n] of got) { if (!expected.has(k)) v.push(`(e) unexpected delivery ${k}`); if (n > 1) v.push(`(e) delivery ${k} recorded ${n} times`); }
  // Sends actually handed to the provider (only comparable when no consumer was killed: a SIGKILL loses the dead process' counter).
  if (opts.notificationSends !== undefined && opts.notificationSends !== expected.size) {
    v.push(`(e) the notifications process sent ${opts.notificationSends} times for ${expected.size} unique deliveries (${kafkaDuplicates} duplicate messages were on the broker)`);
  }

  // Every extra copy of an event on the broker must have been suppressed by the dedup key, at least once per channel (no consumer kill, so the counters are complete).
  // "At least": a copy that lands next to its original is retried while the original is in flight, and each retry counts again.
  if (opts.notificationSuppressed !== undefined) {
    let want = 0;
    for (const o of outbox) want += ((seen.get(Number(o.id)) ?? 1) - 1) * (CHANNELS[o.payload.eventType]?.length ?? 0);
    if (opts.notificationSuppressed < want) v.push(`(e) ${want} duplicate (event, channel) deliveries reached the consumer but it suppressed only ${opts.notificationSuppressed}`);
  }

  // ---- (f) the x-request-id sent by the client at the purchase follows it into the broker headers ---------------------------------
  for (const r of load.records) {
    if (r.payStatus === undefined) continue;
    const p = payByKey.get(r.payKey);
    if (!p) continue;
    if (p.trace?.requestId !== r.payRid) v.push(`(f) payment ${p.id}: stored trace ${p.trace?.requestId} != client x-request-id ${r.payRid}`);
    const o = outByPayment.get(Number(p.id))?.[0];
    if (!o) continue;
    if (o.payload.trace?.requestId !== r.payRid) v.push(`(f) outbox ${o.id}: payload trace ${o.payload.trace?.requestId} != ${r.payRid}`);
    const msgs = stack.bridge.seen.filter((m) => m.outboxId === Number(o.id));
    if (!msgs.length || msgs.some((m) => m.headers["x-request-id"] !== r.payRid)) v.push(`(f) Kafka message(s) for payment ${p.id} lack x-request-id=${r.payRid}`);
  }

  const count = (st: string) => pays.filter((p) => p.status === st).length;
  return {
    violations: v,
    summary: {
      users: load.records.length, impostors: impostors.length, impostors403: impostors.filter((r) => r.impostor!.status === 403).length, payments: pays.length, confirmed: count("CONFIRMED"), refunded: count("REFUNDED"), failed: count("FAILED"),
      regrants, lostAnswerHolds, seatsSold: sold.size, seatsHeld: seats.filter((s) => s.status === "held").length, seatsFree: seats.filter((s) => s.status === "free").length,
      confirmedCents: confirmedSum, outboxEvents: outbox.length, deliveries: deliveries.length, kafkaDuplicates, notificationSends: opts.notificationSends, notificationSuppressed: opts.notificationSuppressed,
      http: Object.fromEntries([...load.stats].sort()), loadMs: load.finishedAt - load.startedAt
    }
  };
}
