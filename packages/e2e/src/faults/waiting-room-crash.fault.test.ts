import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENT, runLoad } from "../load";
import { count, settleAndCheck, startWorld, stopWorld, type World } from "./world";

const SEATS = 150, USERS = 150;
let w: World;
beforeAll(async () => { w = await startWorld("wrcrash", { seats: SEATS, pspLatencyMs: 100, pspFailRate: 0.1, admitPerSecond: 20, seed: 4601 }); }, 180_000);
afterAll(async () => { await stopWorld(w); }, 120_000);

describe("fault 8: kill -9 of the waiting room in the middle of the sale", () => {
  it("queue and admission keys live in Redis and survive the process; the documented ZPOPMIN-then-SET window loses a user's place, never a seat; invariants hold", async () => {
    const s = w.stack;
    const rd = new Redis(w.infra.redisUrl, { maxRetriesPerRequest: 1 }); rd.on("error", () => undefined);
    const q = `wr:${EVENT}:queue`;
    const load = runLoad({ seed: 4601, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 120_000 }, s.runId);
    await s.waitUntil(async () => (await rd.zcard(q)) >= 40 && (await count(s, "payments.payments")) >= 5, 60_000, 50);

    await s.kill("waiting-room");
    expect((await s.procs.get("waiting-room")!.exited).signal).toBe("SIGKILL");
    const queuedAtKill = (await rd.call("ZRANGE", q, "0", "-1", "WITHSCORES")) as string[];
    const keysAtKill = new Set(await rd.keys(`wr:${EVENT}:admitted:*`));
    await new Promise((r) => setTimeout(r, 2000)); // nobody admits meanwhile; the gateway answers 504 to queue calls
    await s.start("waiting-room");
    const queuedAfter = (await rd.call("ZRANGE", q, "0", "-1", "WITHSCORES")) as string[];
    // nothing was lost by the crash itself outside the window; the restarted tick may already have popped a few
    const members = (x: string[]) => x.filter((_, i) => i % 2 === 0);
    const scoreOf = (x: string[]) => new Map(members(x).map((m) => [m, Number(x[x.indexOf(m) + 1])]));
    const beforeScores = scoreOf(queuedAtKill), afterScores = scoreOf(queuedAfter);
    const reordered = [...afterScores].filter(([m, sc]) => beforeScores.has(m) && beforeScores.get(m) !== sc);
    const keysAfterRestart = new Set(await rd.keys(`wr:${EVENT}:admitted:*`));
    const lostKeys = [...keysAtKill].filter((k) => !keysAfterRestart.has(k));

    const result = await load;
    const rejoins = result.stats.get("queue:unknown-rejoin") ?? 0;

    // The window itself (ADR 001): ZPOPMIN has returned, the key writes have not happened. A kill -9 cannot be aimed at a gap of microseconds,
    // so the interleaving is produced directly in Redis (this part is a SIMULATION of the crash, not a crash): the user vanishes from the queue and has no key.
    const victim = `${s.userPrefix}window`;
    await rd.zadd(q, 1e9, victim);                                    // a user at the very end of the queue
    const [popped] = await rd.zpopmax(q, 1);                           // popped, then "the process died before SET"
    expect(popped).toBe(victim);
    const status = async (u: string) => (await (await fetch(`${s.urls.gateway}/events/${EVENT}/queue/status?userId=${u}`)).json()) as { state: string; position?: number; token?: string };
    const afterWindow = await status(victim);
    const rejoin = await (await fetch(`${s.urls.gateway}/events/${EVENT}/queue/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ userId: victim }) })).json() as { position: number };
    let admittedAgain: { state: string; token?: string } = { state: "?" };
    await s.waitUntil(async () => { admittedAgain = await status(victim); return admittedAgain.state === "admitted"; }, 30_000, 200);

    const { report, quiet } = await settleAndCheck(w, result, { seats: SEATS, quiescentMs: 120_000 });
    await rd.quit().catch(() => undefined);
    console.log("waiting-room crash:", quiet, JSON.stringify({ queuedAtKill: queuedAtKill.length / 2, queuedAfter: queuedAfter.length / 2, keysAtKill: keysAtKill.size, lostKeys: lostKeys.length, reordered: reordered.length, rejoins, afterWindow, rejoin, ...report.summary }));

    // Redis kept everything: the queue (same members, same scores) and every admission key
    expect(queuedAtKill.length / 2).toBeGreaterThanOrEqual(10);
    expect(keysAtKill.size).toBeGreaterThan(0);
    expect(reordered).toEqual([]);
    expect(lostKeys).toEqual([]);
    // every client finished (some may have had to re-join if they fell into the window); no seat or money consequence
    expect(report.violations.join("\n")).toBe("");
    // documented loss: a user popped without a key is "unknown", re-joins at the END of the queue and is admitted again
    expect(afterWindow.state).toBe("unknown");
    expect(rejoin.position).toBeGreaterThanOrEqual(1);
    expect(admittedAgain.state).toBe("admitted");
    expect((report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
  }, 230_000);
});
