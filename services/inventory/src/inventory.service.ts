import { Inject, Injectable, Optional } from "@nestjs/common";
import { Pool } from "pg";

export type Strategy = "for-update" | "atomic-update";
export type HoldResult = { ok: true; seatIds: number[]; holdUntil: Date } | { ok: false; reason: "unavailable" };

export const PG = "PG_POOL";
/** Default hold duration; `HOLD_SECONDS` in the environment overrides it (read in app.module.ts, validated in main.ts). */
export const HOLD_SECONDS = 600;
export const HOLD_TTL = "HOLD_TTL_SECONDS";

@Injectable()
export class InventoryService {
  constructor(@Inject(PG) private readonly pool: Pool, @Optional() @Inject(HOLD_TTL) private readonly holdSeconds: number = HOLD_SECONDS) {}

  /**
   * Hold seats for `holdSeconds` (default HOLD_SECONDS). All-or-nothing.
   * - atomic-update: one UPDATE ... WHERE free-or-expired RETURNING, compare row count. No explicit lock round trip.
   * - for-update: SELECT ... FOR UPDATE (ordered, to avoid deadlocks), check, then UPDATE. Two round trips, holds locks longer.
   */
  async hold(eventId: number, seatIds: number[], userId: string, strategy: Strategy = "atomic-update"): Promise<HoldResult> {
    const ids = [...new Set(seatIds)].sort((a, b) => a - b);
    return strategy === "for-update" ? this.holdForUpdate(eventId, ids, userId) : this.holdAtomic(eventId, ids, userId);
  }

  private async holdAtomic(eventId: number, ids: number[], userId: string): Promise<HoldResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        // One statement, but the rows are locked in seat_id order first (MATERIALIZED + ORDER BY ... FOR UPDATE).
        // A bare multi-row UPDATE locks rows in whatever order the plan visits them; a hold and a confirm that get
        // different plans then deadlock (40P01), see the lock-order test.
        `WITH locked AS MATERIALIZED (
           SELECT seat_id FROM seats
           WHERE event_id=$1 AND seat_id = ANY($2)
             AND (status='free' OR (status='held' AND hold_until < now()))
           ORDER BY seat_id FOR UPDATE)
         UPDATE seats s SET status='held', held_by=$3, hold_until = now() + make_interval(secs => $4)
         FROM locked WHERE s.event_id=$1 AND s.seat_id = locked.seat_id
         RETURNING s.hold_until`,
        [eventId, ids, userId, this.holdSeconds]
      );
      if (res.rowCount !== ids.length) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "unavailable" };
      }
      await client.query("COMMIT");
      return { ok: true, seatIds: ids, holdUntil: res.rows[0].hold_until };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private async holdForUpdate(eventId: number, ids: number[], userId: string): Promise<HoldResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await client.query(
        `SELECT seat_id FROM seats
         WHERE event_id=$1 AND seat_id = ANY($2)
           AND (status='free' OR (status='held' AND hold_until < now()))
         ORDER BY seat_id FOR UPDATE`,
        [eventId, ids]
      );
      if (rows.rowCount !== ids.length) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "unavailable" };
      }
      const upd = await client.query(
        `UPDATE seats SET status='held', held_by=$3, hold_until = now() + make_interval(secs => $4)
         WHERE event_id=$1 AND seat_id = ANY($2) RETURNING hold_until`,
        [eventId, ids, userId, this.holdSeconds]
      );
      await client.query("COMMIT");
      return { ok: true, seatIds: ids, holdUntil: upd.rows[0].hold_until };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Confirm a hold into a sale; only the holder, only while the hold is valid. All-or-nothing, like hold. */
  async confirm(eventId: number, seatIds: number[], userId: string): Promise<boolean> {
    const ids = [...new Set(seatIds)];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        // Idempotent: a retry after a lost response (timeout) must still succeed, so already-sold-to-this-user counts.
        // Same lock order as hold (seat_id ascending), so the two can never wait on each other in a cycle.
        `WITH locked AS MATERIALIZED (
           SELECT seat_id FROM seats
           WHERE event_id=$1 AND seat_id = ANY($2) AND held_by=$3
             AND ((status='held' AND hold_until >= now()) OR status='sold')
           ORDER BY seat_id FOR UPDATE)
         UPDATE seats s SET status='sold', hold_until=NULL
         FROM locked WHERE s.event_id=$1 AND s.seat_id = locked.seat_id`,
        [eventId, ids, userId]
      );
      // A partial match must not sell the seats that did match while reporting failure to the caller.
      if (res.rowCount !== ids.length) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query("COMMIT");
      return true;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async availability(eventId: number): Promise<{ free: number; held: number; sold: number }> {
    const res = await this.pool.query(
      `SELECT
         count(*) FILTER (WHERE status='free' OR (status='held' AND hold_until < now()))::int AS free,
         count(*) FILTER (WHERE status='held' AND hold_until >= now())::int AS held,
         count(*) FILTER (WHERE status='sold')::int AS sold
       FROM seats WHERE event_id=$1`,
      [eventId]
    );
    return res.rows[0];
  }
}
