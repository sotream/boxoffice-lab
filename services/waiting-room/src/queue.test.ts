import Redis from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { QueueService } from "./queue.service";

const redis = new Redis("redis://localhost:56379");
const q = new QueueService(redis);
const E = 901;
beforeEach(() => q.reset(E));
afterAll(() => redis.quit());

describe("waiting room", () => {
  it("keeps FIFO order under concurrent joins", async () => {
    const users = Array.from({ length: 200 }, (_, i) => `u${i}`);
    await Promise.all(users.map((u) => q.join(E, u)));
    const score = async (id: string) => Number(await redis.zscore(`wr:${E}:queue`, id));
    const before = new Map<string, number>();
    for (const u of users) before.set(u, await score(u));
    const admitted = await q.admit(E, 50);
    expect(admitted).toHaveLength(50);
    expect(await q.length(E)).toBe(150);
    const maxAdmitted = Math.max(...admitted.map((id) => before.get(id)!));
    const waiting = users.filter((u) => !admitted.includes(u));
    const minWaiting = Math.min(...waiting.map((id) => before.get(id)!));
    expect(maxAdmitted).toBeLessThan(minWaiting);
  });

  it("re-join is idempotent and keeps the place", async () => {
    await q.join(E, "a"); await q.join(E, "b");
    expect((await q.join(E, "a")).position).toBe(1);
    expect(await q.length(E)).toBe(2);
  });

  it("status moves from waiting to admitted, with a TTL", async () => {
    await q.join(E, "a"); await q.join(E, "b");
    expect(await q.status(E, "b", 10)).toMatchObject({ state: "waiting", position: 2 });
    await q.admit(E, 1);
    expect(await q.status(E, "a", 10)).toMatchObject({ state: "admitted" });
    expect(await q.isAdmitted(E, "b")).toBe(false);
    expect(await q.status(E, "nobody", 10)).toEqual({ state: "unknown" });
  });

  it("admits at most n and never the same user twice", async () => {
    await Promise.all(["a", "b", "c"].map((u) => q.join(E, u)));
    const first = await q.admit(E, 2);
    const second = await q.admit(E, 2);
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["c"]);
  });
});
