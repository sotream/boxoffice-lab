import { streamFor } from "./prng";

export const EVENT = 1; // the waiting-room admission tick serves event 1 only
export const SEAT_PRICE_CENTS = 2500;

/**
 * buyer: holds and pays. abandoner: holds, never pays. cheater: pays (as itself) for a seat another user holds; hold ownership is
 * checked only at confirm, so the card is charged and then refunded. impostor: sends another user's id in the pay body through the
 * gateway; the gateway must answer 403 and nothing may be charged.
 */
export type Kind = "buyer" | "abandoner" | "cheater" | "impostor";
export interface UserRecord {
  index: number; userId: string; kind: Kind;
  holds: { seatIds: number[]; rid: string }[];
  /** All seats this user was granted by a 200 on /holds. */
  seats: number[];
  payKey: string; payRid: string; amountCents: number;
  /** Final answer the client saw (HTTP 200, not in progress). */
  payStatus?: string; paymentId?: number;
  /** For double-submitting users: the ids/status the concurrent twin saw. */
  twin?: { status: string; paymentId: number };
  payAttempts: number;
  /** Client clock: when the first pay request started, and when the last hold response arrived (hold-expiry scenario). */
  payStartedAt?: number; lastHoldEnd?: number;
  /** For impostors: whose id was put in the body, and what the gateway answered (must be 403). */
  impostor?: { victim: string; status: number };
  error?: string;
}
export interface LoadConfig {
  seed: number; users: number; seats: number;
  gateway: string;            // queue, holds and pay (payments is not reachable by clients, only through the gateway)
  holdGateway?: string;       // holds go here when set (overload scenario)
  concurrency?: number;
  deadlineMs?: number;        // per user
  /** Extra concurrent hold attempts per user (overload): all fired at once, each with its own random seats. */
  holdStorm?: number;
  mix?: { abandoner: number; cheater: number; doubleSubmit: number; impostor?: number };
  /** Extra delay (ms) between the last hold and the first pay request of a user; lets some users pay after their hold expired. */
  payDelayMs?: (p: { index: number; kind: Kind; rnd: () => number }) => number;
  /** Added to every user index (a second wave in the same stack must not reuse user ids). */
  userOffset?: number;
  /** Filled while the load runs: seat -> users granted (the same Map is returned as `grants`), so a fault can be injected knowing what was promised. */
  grantsLive?: Map<number, string[]>;
  /** Called with the number of users finished, for progress/chaos triggers. */
  onProgress?: (done: number) => void;
}
export interface LoadResult {
  records: UserRecord[];
  /** `${tag}:${status}` -> count; network errors are `${tag}:neterr`. */
  stats: Map<string, number>;
  /** 429 responses without a usable Retry-After header. */
  retryAfterMissing: number;
  /** Every /holds request per user: when it started and ended, and the HTTP status (0 = network error). */
  holdAttemptsByUser: Map<string, { start: number; end: number; status: number }[]>;
  /** seat -> users that were told 200 for it (must never have two, unless the first hold had expired). */
  grants: Map<number, string[]>;
  /** The same grants with the client clock: request start and response arrival, in arrival order. */
  grantsTimed: Map<number, { user: string; start: number; end: number }[]>;
  /** Holds whose answer never arrived or was a 5xx: the server may have granted them. seat -> users. A seat held by such a user is legitimate. */
  ambiguous: Map<number, Set<string>>;
  startedAt: number; finishedAt: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runLoad(cfg: LoadConfig, runId: string): Promise<LoadResult> {
  const userPrefix = `u-${runId}-`;
  const mix = { impostor: 0.04, ...(cfg.mix ?? { abandoner: 0.1, cheater: 0.06, doubleSubmit: 0.1 }) };
  const deadlineMs = cfg.deadlineMs ?? 90_000;
  const stats = new Map<string, number>();
  const grants = cfg.grantsLive ?? new Map<number, string[]>();
  const grantsTimed = new Map<number, { user: string; start: number; end: number }[]>();
  const ambiguous = new Map<number, Set<string>>();
  const holdAttemptsByUser = new Map<string, { start: number; end: number; status: number }[]>();
  const holder = new Map<number, string>();
  let retryAfterMissing = 0;
  const bump = (k: string) => stats.set(k, (stats.get(k) ?? 0) + 1);

  const call = async (tag: string, url: string, init: RequestInit): Promise<{ status: number; body: any; retryAfter: string | null } | null> => {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
      bump(`${tag}:${res.status}`);
      const ra = res.headers.get("retry-after");
      if (res.status === 429 && !(ra && Number(ra) >= 1)) retryAfterMissing++;
      let body: any = null;
      try { body = await res.json(); } catch { /* not json */ }
      return { status: res.status, body, retryAfter: ra };
    } catch { bump(`${tag}:neterr`); return null; }
  };
  const json = (rid: string, extra: Record<string, string> = {}) => ({ "content-type": "application/json", "x-request-id": rid, ...extra });

  const records: UserRecord[] = [];
  const plans = Array.from({ length: cfg.users }, (_, k) => {
    const i = k + (cfg.userOffset ?? 0);
    const r = streamFor(cfg.seed, i);
    const x = r();
    const kind: Kind = x < mix.cheater ? "cheater" : x < mix.cheater + mix.impostor ? "impostor" : x < mix.cheater + mix.impostor + mix.abandoner ? "abandoner" : "buyer";
    const wants = r() < 0.35 ? 2 : 1;
    return { i, kind, wants, delay: Math.floor(r() * 1500), twin: r() < mix.doubleSubmit, rnd: streamFor(cfg.seed ^ 0x9e3779b9, i) };
  });

  const pickSeats = (rnd: () => number, n: number) => {
    const s = new Set<number>();
    while (s.size < n) s.add(1 + Math.floor(rnd() * cfg.seats));
    return [...s].sort((a, b) => a - b);
  };

  const payLoop = async (rec: UserRecord, seatIds: number[], t0: number, token: string) => {
    for (;;) {
      if (Date.now() - t0 > deadlineMs) throw new Error("pay deadline");
      rec.payAttempts++;
      const r = await call("pay", `${cfg.gateway}/events/${EVENT}/pay`, {
        method: "POST", headers: json(rec.payRid, { "idempotency-key": rec.payKey, "x-admission": token }),
        body: JSON.stringify({ eventId: EVENT, userId: rec.userId, seatIds, amountCents: rec.amountCents })
      });
      // 429 (limiter), 503 (limiter down), 504 and 202 are retried with the same key; any other 4xx is a contract violation, not something to wait out
      if (r && r.status >= 400 && r.status < 500 && r.status !== 429) throw new Error(`pay refused with ${r.status} ${JSON.stringify(r.body)}`);
      if (r && r.status === 200 && r.body && r.body.inProgress === false) return { status: r.body.status as string, paymentId: Number(r.body.paymentId) };
      await sleep(r ? 150 : 300); // 202 in progress, 5xx, or the service is down (chaos): same key again
    }
  };

  const runUser = async (p: (typeof plans)[number]) => {
    const userId = `${userPrefix}${p.i}`;
    const rec: UserRecord = { index: p.i, userId, kind: p.kind, holds: [], seats: [], payKey: `k-${userId}`, payRid: `${userId}-pay`, amountCents: 0, payAttempts: 0 };
    records.push(rec);
    const t0 = Date.now();
    try {
      await sleep(p.delay);
      // 1. queue: join (idempotent), then poll until admitted
      let token: string | undefined;
      let joined = false;
      while (!token) {
        if (Date.now() - t0 > deadlineMs) throw new Error("admission deadline");
        if (!joined) {
          const j = await call("join", `${cfg.gateway}/events/${EVENT}/queue/join`, { method: "POST", headers: json(`${userId}-join`), body: JSON.stringify({ userId }) });
          if (j && (j.status === 201 || j.status === 200)) joined = true; else { await sleep(200); continue; }
        }
        const st = await call("status", `${cfg.gateway}/events/${EVENT}/queue/status?userId=${encodeURIComponent(userId)}`, { headers: json(`${userId}-status`) });
        if (st?.status === 200 && st.body?.state === "admitted") token = st.body.token;
        else if (st?.status === 200 && st.body?.state === "unknown") { joined = false; bump("queue:unknown-rejoin"); }
        else await sleep(120 + Math.floor(p.rnd() * 80));
      }

      // 2. holds (cheaters and impostors do not hold: they go for someone else's seats)
      const holdUrl = `${cfg.holdGateway ?? cfg.gateway}/events/${EVENT}/holds`;
      const tryHold = async (seatIds: number[], n: number): Promise<boolean | "retry"> => {
        const rid = `${userId}-hold-${n}`;
        const start = Date.now();
        const r = await call("hold", holdUrl, { method: "POST", headers: json(rid, { "x-admission": token! }), body: JSON.stringify({ seatIds, userId }) });
        const end = Date.now();
        (holdAttemptsByUser.get(userId) ?? holdAttemptsByUser.set(userId, []).get(userId)!).push({ start, end, status: r?.status ?? 0 });
        if (r?.status === 200 || r?.status === 201) {
          rec.holds.push({ seatIds, rid }); rec.lastHoldEnd = end;
          for (const s of seatIds) { rec.seats.push(s); holder.set(s, userId); (grants.get(s) ?? grants.set(s, []).get(s)!).push(userId); (grantsTimed.get(s) ?? grantsTimed.set(s, []).get(s)!).push({ user: userId, start, end }); }
          return true;
        }
        if (!r || r.status >= 500) for (const s of seatIds) (ambiguous.get(s) ?? ambiguous.set(s, new Set()).get(s)!).add(userId); // the server may have granted it before the answer was lost
        if (r && (r.status === 429 || r.status >= 500) || !r) return "retry";
        return false; // 409: someone else has it
      };
      if (p.kind === "impostor") {
        // An admitted user puts somebody else's id in the pay body. The token says who they are, so the gateway must refuse, and no money may move.
        for (let w = 0; w < 30 && holder.size === 0; w++) await sleep(100);
        const others = [...holder.entries()].filter(([, u]) => u !== userId);
        const [seat, victim] = others.length ? others[Math.floor(p.rnd() * others.length)] : [pickSeats(p.rnd, 1)[0], `${userPrefix}nobody`];
        // A network error or a 5xx is not an answer (the gateway may be down in a chaos run): ask again, the refusal must come from a live gateway.
        let r = await call("impostor-pay", `${cfg.gateway}/events/${EVENT}/pay`, {
          method: "POST", headers: json(rec.payRid, { "idempotency-key": rec.payKey, "x-admission": token }),
          body: JSON.stringify({ eventId: EVENT, userId: victim, seatIds: [seat], amountCents: SEAT_PRICE_CENTS })
        });
        while ((!r || r.status >= 500) && Date.now() - t0 < deadlineMs) {
          await sleep(300);
          r = await call("impostor-pay", `${cfg.gateway}/events/${EVENT}/pay`, {
            method: "POST", headers: json(rec.payRid, { "idempotency-key": rec.payKey, "x-admission": token }),
            body: JSON.stringify({ eventId: EVENT, userId: victim, seatIds: [seat], amountCents: SEAT_PRICE_CENTS })
          });
        }
        rec.impostor = { victim, status: r?.status ?? 0 };
        return;
      }
      if (p.kind !== "cheater") {
        if (cfg.holdStorm) {
          await Promise.all(Array.from({ length: cfg.holdStorm }, (_, n) => tryHold(pickSeats(p.rnd, p.wants), n)));
        } else {
          for (let attempt = 0, n = 0; attempt < 4 && rec.seats.length === 0; n++) {
            if (Date.now() - t0 > deadlineMs) throw new Error("hold deadline");
            const r = await tryHold(pickSeats(p.rnd, p.wants), n);
            if (r === "retry") { await sleep(1000); continue; }
            if (r === false) attempt++;
          }
        }
        rec.seats = [...new Set(rec.seats)].sort((a, b) => a - b);
        if (rec.seats.length === 0 || p.kind === "abandoner") return;
      } else {
        // wait (bounded) until somebody holds something, then pay (as itself, with its own token) for a seat that belongs to another user:
        // the gateway cannot know who holds what, so the charge happens and inventory refuses the confirm (owner check) -> refund
        for (let w = 0; w < 30 && holder.size === 0; w++) await sleep(100);
        const others = [...holder.entries()].filter(([, u]) => u !== userId).map(([s]) => s).sort((a, b) => a - b);
        rec.seats = others.length ? [others[Math.floor(p.rnd() * others.length)]] : pickSeats(p.rnd, 1);
      }

      // 3. pay through the gateway (token, per-user limiter, internal credential added there), with an Idempotency-Key; some users submit twice at once
      const wait = cfg.payDelayMs?.({ index: p.i, kind: p.kind, rnd: p.rnd }) ?? 0;
      if (wait > 0) await sleep(wait);
      rec.payStartedAt = Date.now();
      rec.amountCents = SEAT_PRICE_CENTS * rec.seats.length;
      const seatIds = rec.seats.slice(0, 8);
      if (p.twin) {
        const [a, b] = await Promise.all([payLoop(rec, seatIds, t0, token!), payLoop(rec, seatIds, t0, token!)]);
        rec.payStatus = a.status; rec.paymentId = a.paymentId; rec.twin = b;
      } else {
        const a = await payLoop(rec, seatIds, t0, token!);
        rec.payStatus = a.status; rec.paymentId = a.paymentId;
      }
    } catch (e) { rec.error = (e as Error).message; }
  };

  const startedAt = Date.now();
  let done = 0; let next = 0;
  const worker = async () => { for (;;) { const p = plans[next++]; if (!p) return; await runUser(p); cfg.onProgress?.(++done); } };
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency ?? 150, plans.length) }, worker));
  records.sort((a, b) => a.index - b.index);
  return { records, stats, retryAfterMissing, holdAttemptsByUser, grants, grantsTimed, ambiguous, startedAt, finishedAt: Date.now() };
}

/** Two waves of the same sale as one result (the second started with a `userOffset`), for the invariants. */
export function mergeLoads(a: LoadResult, b: LoadResult): LoadResult {
  const stats = new Map(a.stats);
  for (const [k, n] of b.stats) stats.set(k, (stats.get(k) ?? 0) + n);
  const merge = <V>(x: Map<number, V[]>, y: Map<number, V[]>, by: (v: V) => number) => {
    const m = new Map<number, V[]>();
    for (const src of [x, y]) for (const [k, v] of src) m.set(k, [...(m.get(k) ?? []), ...v]);
    for (const v of m.values()) v.sort((p, q) => by(p) - by(q));
    return m;
  };
  const ambiguous = new Map<number, Set<string>>();
  for (const src of [a.ambiguous, b.ambiguous]) for (const [k, v] of src) ambiguous.set(k, new Set([...(ambiguous.get(k) ?? []), ...v]));
  const timed = merge(a.grantsTimed, b.grantsTimed, (g) => g.end);
  const grants = new Map<number, string[]>([...timed].map(([k, v]) => [k, v.map((g) => g.user)]));
  return {
    records: [...a.records, ...b.records].sort((p, q) => p.index - q.index), stats, retryAfterMissing: a.retryAfterMissing + b.retryAfterMissing,
    holdAttemptsByUser: new Map([...a.holdAttemptsByUser, ...b.holdAttemptsByUser]), grants, grantsTimed: timed, ambiguous,
    startedAt: Math.min(a.startedAt, b.startedAt), finishedAt: Math.max(a.finishedAt, b.finishedAt)
  };
}
