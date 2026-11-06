import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Param, ParseIntPipe, Post, Query } from "@nestjs/common";
import { InventoryService, Strategy } from "./inventory.service";

interface HoldBody { seatIds: number[]; userId: string }

@Controller("events/:eventId")
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly svc: InventoryService) {}

  @Post("holds")
  async hold(@Param("eventId", ParseIntPipe) eventId: number, @Body() body: HoldBody, @Query("strategy") strategy?: Strategy) {
    if (!Array.isArray(body?.seatIds) || body.seatIds.length === 0 || body.seatIds.length > 8 || typeof body.userId !== "string") {
      throw new BadRequestException("seatIds (1-8) and userId required");
    }
    const r = await this.svc.hold(eventId, body.seatIds, body.userId, strategy === "for-update" ? "for-update" : "atomic-update");
    if (!r.ok) throw new ConflictException("seats unavailable");
    return { seatIds: r.seatIds, holdUntil: r.holdUntil };
  }

  @Post("confirm")
  async confirm(@Param("eventId", ParseIntPipe) eventId: number, @Body() body: HoldBody) {
    const ok = await this.svc.confirm(eventId, body.seatIds, body.userId);
    if (!ok) throw new ConflictException("hold missing or expired");
    return { sold: body.seatIds };
  }

  @Get("availability")
  availability(@Param("eventId", ParseIntPipe) eventId: number) {
    return this.svc.availability(eventId);
  }
}
