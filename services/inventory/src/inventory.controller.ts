import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Param, ParseIntPipe, Post, Query } from "@nestjs/common";
import { InventoryService, Strategy } from "./inventory.service";
import { confirms, holds } from "./metrics";

interface HoldBody { seatIds: number[]; userId: string }

@Controller("events/:eventId")
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly svc: InventoryService) {}

  @Post("holds")
  async hold(@Param("eventId", ParseIntPipe) eventId: number, @Body() body: HoldBody, @Query("strategy") strategy?: Strategy) {
    if (!Array.isArray(body?.seatIds) || body.seatIds.length === 0 || body.seatIds.length > 8 || typeof body.userId !== "string") {
      throw new BadRequestException("seatIds (1-8) and userId required");
    }
    const s: Strategy = strategy === "for-update" ? "for-update" : "atomic-update"; // two values only: bounded metric label
    let r;
    try { r = await this.svc.hold(eventId, body.seatIds, body.userId, s); }
    catch (e) { holds.inc({ strategy: s, result: "error" }); throw e; }
    holds.inc({ strategy: s, result: r.ok ? "ok" : "conflict" });
    if (!r.ok) throw new ConflictException("seats unavailable");
    return { seatIds: r.seatIds, holdUntil: r.holdUntil };
  }

  @Post("confirm")
  async confirm(@Param("eventId", ParseIntPipe) eventId: number, @Body() body: HoldBody) {
    // Same shape check as hold: an empty or missing seat list must not "succeed" (it matches zero rows) or crash with a 500.
    if (!Array.isArray(body?.seatIds) || body.seatIds.length === 0 || body.seatIds.length > 8 || typeof body.userId !== "string") {
      throw new BadRequestException("seatIds (1-8) and userId required");
    }
    let ok: boolean;
    try { ok = await this.svc.confirm(eventId, body.seatIds, body.userId); }
    catch (e) { confirms.inc({ result: "error" }); throw e; }
    confirms.inc({ result: ok ? "ok" : "conflict" });
    if (!ok) throw new ConflictException("hold missing or expired");
    return { sold: body.seatIds };
  }

  @Get("availability")
  availability(@Param("eventId", ParseIntPipe) eventId: number) {
    return this.svc.availability(eventId);
  }
}
