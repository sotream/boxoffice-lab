import { signAdmission } from "@boxoffice/admission";
import Redis from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVENT, runLoad } from "../load";
import { SECRET } from "../stack";
import { count, settleAndCheck, startWorld, stopWorld, type World } from "./world";

const SEATS = 80, USERS = 200;
let w: World;
beforeAll(async () => { w = await startWorld("gwcrash", { seats: SEATS, pspLatencyMs: 150, pspFailRate: 0.1, admitPerSecond: 100, seed: 4501 }); }, 180_000);
afterAll(async () => { await stopWorld(w); }, 120_000);

describe("fault 5: kill -9 of the gateway in the middle of the sale", () => {
  it("clients retry against the restarted gateway, rate-limit buckets survive (they live in Redis), invariants hold", async () => {
    const s = w.stack;
    // a gateway with a tiny per-user bucket that is NOT part of the load, to show that bucket state is outside the process
    const tight = await s.startExtra("gateway", "gateway-tight", { USER_RATE: "0.0001", USER_BURST: "3" });
    const probeUser = `${s.userPrefix}bucket`;
    const hdr = { "content-type": "application/json", "x-admission": signAdmission(probeUser, EVENT, 120, SECRET) };
    // a body for another user: the limiter runs first and consumes a token, the identity check then answers 403 and nothing else happens
    const spend = async () => (await fetch(`${tight.url}/events/${EVENT}/holds`, { method: "POST", headers: hdr, body: JSON.stringify({ seatIds: [1], userId: "somebody-else" }) })).status;
    const first = [await spend(), await spend(), await spend()];
    const fourth = await spend();

    const load = runLoad({ seed: 4501, users: USERS, seats: SEATS, gateway: s.urls.gateway, concurrency: USERS, deadlineMs: 120_000 }, s.runId);
    await s.waitUntil(async () => (await count(s, "payments.payments")) >= 20, 60_000, 20);
    const rl = new Redis(w.infra.redisUrl, { maxRetriesPerRequest: 1 }); rl.on("error", () => undefined);
    const bucketKeysBefore = (await rl.keys("rl:user:*")).sort();
    const probeKey = `rl:user:${probeUser}`;
    const probeBefore = await rl.exists(probeKey);
    await s.kill("gateway");
    expect((await s.procs.get("gateway")!.exited).signal).toBe("SIGKILL");
    await s.kill("gateway-tight");
    await new Promise((r) => setTimeout(r, 2000)); // clients see connection refused and retry
    await s.start("gateway");
    await s.start("gateway-tight");
    const probeAfterRestart = await rl.exists(probeKey);   // read before the post-restart requests touch it
    const bucketKeysAfter = (await rl.keys("rl:user:*")).sort();
    // the restarted tight gateway still refuses: a fresh in-memory bucket would have admitted three more
    const afterRestart = [await spend(), await spend()];
    await rl.quit().catch(() => undefined);

    const result = await load;
    const { report, quiet } = await settleAndCheck(w, result, { seats: SEATS });
    const neterr = [...result.stats].filter(([k]) => k.endsWith(":neterr")).reduce((n, [, c]) => n + c, 0);
    console.log("gateway crash:", quiet, JSON.stringify({ first, fourth, afterRestart, bucketKeysBefore: bucketKeysBefore.length, bucketKeysAfter: bucketKeysAfter.length, neterr, ...report.summary }));

    expect(first).toEqual([403, 403, 403]);        // the burst of 3 was admitted (and refused by the identity check)
    expect(fourth).toBe(429);                      // the bucket is empty
    expect(afterRestart).toEqual([429, 429]);      // still empty after kill -9 + restart: state is in Redis
    expect(bucketKeysBefore.length).toBeGreaterThan(20);
    expect(probeBefore).toBe(1);
    expect(probeAfterRestart, "the bucket of the probe user after kill -9 + restart").toBe(1);
    expect(neterr).toBeGreaterThan(0);             // the crash was felt by clients, and they retried
    expect(report.violations.join("\n")).toBe("");
    expect((report.summary as Record<string, number>).confirmed).toBeGreaterThan(10);
  }, 230_000);
});
