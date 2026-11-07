import { startInfra, type Infra } from "../docker";
import { checkInvariants, waitQuiescent, type CheckOptions, type Report } from "../invariants";
import type { LoadResult } from "../load";
import { Stack, type StackOptions } from "../stack";

/** One fault scenario's private world: its own Postgres, Redis and Redpanda containers and every service on top of them. */
export interface World { infra: Infra; stack: Stack }

export async function startWorld(tag: string, opts: Omit<StackOptions, "tag" | "infra">): Promise<World> {
  const infra = await startInfra();
  try { return { infra, stack: await Stack.start({ ...opts, tag, infra }) }; }
  catch (e) { await infra.stop(); throw e; }
}

/** Always removes the containers, even if stopping the services fails. */
export async function stopWorld(w: World | undefined): Promise<void> {
  if (!w) return;
  try { await w.stack.stop(); } finally { await w.infra.stop(); }
}

export const count = async (s: Stack, sql: string, params: unknown[] = []): Promise<number> => Number((await s.q<{ n: string }>(`SELECT count(*) n FROM ${sql}`, params))[0].n);
export const tryCount = async (s: Stack, sql: string): Promise<number | undefined> => { try { return await count(s, sql); } catch { return undefined; } };

/** GET /readyz: the HTTP status, or null when nothing answered in 2 s. */
export async function readyz(base: string): Promise<number | null> {
  try { return (await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(2000) })).status; } catch { return null; }
}

/** Samples /readyz of several processes every 400 ms until stopped; keeps the full history. */
export class ReadySampler {
  readonly history = new Map<string, { at: number; status: number | null }[]>();
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly targets: Record<string, string>) { for (const k of Object.keys(targets)) this.history.set(k, []); }
  start() {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void Promise.all(Object.entries(this.targets).map(async ([k, base]) => { const status = await readyz(base); this.history.get(k)!.push({ at: Date.now(), status }); }  /* timestamp = when the answer arrived */)).finally(() => { this.running = false; });
    }, 400);
  }
  stop() { clearInterval(this.timer); }
  /** Statuses seen in [from, to]. */
  between(k: string, from: number, to: number) { return this.history.get(k)!.filter((h) => h.at >= from && h.at <= to).map((h) => h.status); }
  after(k: string, from: number) { return this.history.get(k)!.filter((h) => h.at >= from).map((h) => h.status); }
}

/** After the load: poll (with deadlines) until everything is terminal and delivered, then check the invariants. Violations are returned, not thrown. */
export async function settleAndCheck(w: World, load: LoadResult, opts: CheckOptions & { quiescentMs?: number }): Promise<{ report: Report; quiet: string }> {
  const paid = load.records.filter((r) => r.payStatus !== undefined).length;
  const quiet = await waitQuiescent(w.stack, paid, opts.quiescentMs ?? 90_000);
  await new Promise((r) => setTimeout(r, 1500)); // the consumer's last commits and the log syncer
  const report = await checkInvariants(w.stack, load, opts);
  return { report, quiet };
}

export const serverErrors = (load: LoadResult) => [...load.stats].filter(([k]) => /:(5\d\d|neterr)$/.test(k));

/** On a failed scenario: the tail of every process' log, so a hang can be diagnosed from the run output alone. */
export function dumpLogs(s: Stack, labels: string[] = ["gateway", "waiting-room", "inventory", "payments", "notifications"], tail = 1800): void {
  for (const l of labels) console.log(`--- ${l} log (tail) ---\n${s.log(l).slice(-tail)}`);
}

/** Users with a REFUNDED payment who are not cheaters. With a long hold nobody legitimate is refunded: a refund means the saga read "seats lost" where the truth was "unknown". */
export async function refundedNonCheaters(s: Stack, load: LoadResult): Promise<string[]> {
  const kindOf = new Map(load.records.map((r) => [r.userId, r.kind]));
  return (await s.q<{ user_id: string }>(`SELECT user_id FROM payments.payments WHERE status='REFUNDED'`)).map((r) => r.user_id).filter((u) => kindOf.get(u) !== "cheater");
}
