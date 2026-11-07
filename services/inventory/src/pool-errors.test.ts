import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "./db";

const admin = createPool(1);
afterAll(async () => { await admin.end(); });

describe("a checked-out client whose connection is terminated", () => {
  it("does not kill the process (no unhandled 'error' event), the query fails, the pool recovers", async () => {
    const pool = createPool(2);
    const unhandled: unknown[] = [];
    const h = (e: unknown) => unhandled.push(e);
    process.on("uncaughtException", h);
    try {
      const client = await pool.connect();
      await client.query("BEGIN");
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      // Postgres goes away between two statements of a transaction (what 'docker stop' does under load)
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await new Promise((r) => setTimeout(r, 300));
      await expect(client.query("SELECT 1")).rejects.toBeTruthy();
      client.release(true);
      expect(unhandled).toEqual([]);
      expect((await pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1); // a new connection works
    } finally {
      process.off("uncaughtException", h);
      await pool.end();
    }
  });
});
