import { Inject, Injectable } from "@nestjs/common";
import { Pool } from "pg";

export type Strategy = "for-update" | "atomic-update";
export type HoldResult = { ok: true; seatIds: number[]; holdUntil: Date } | { ok: false; reason: "unavailable" };

export const PG = "PG_POOL";
export const HOLD_SECONDS = 600;

@Injectable()
export class InventoryService {
  constructor(@Inject(PG) private readonly pool: Pool) {}

  /**
   * Hold seats for HOLD_SECONDS. All-or-nothing.
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
        `UPDATE seats SET status='held', held_by=$3, hold_until = now() + make_interval(secs => $4)
         WHERE event_id=$1 AND seat_id = ANY($2)
           AND (status='free' OR (status='held' AND hold_until < now()))
         RETURNING hold_until`,
        [eventId, ids, userId, HOLD_SECONDS]
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
        [eventId, ids, userId, HOLD_SECONDS]
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

  /** Confirm a hold into a sale; only the holder, only while the hold is valid. */
  async confirm(eventId: number, seatIds: number[], userId: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE seats SET status='sold', hold_until=NULL
       WHERE event_id=$1 AND seat_id = ANY($2) AND status='held' AND held_by=$3 AND hold_until >= now()`,
      [eventId, seatIds, userId]
    );
    return res.rowCount === seatIds.length;
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
