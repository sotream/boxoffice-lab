import { BadRequestException, Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query } from "@nestjs/common";
import { signAdmission } from "@boxoffice/admission";
import { QueueService } from "./queue.service";

export const ADMISSION_SECRET = process.env.ADMISSION_SECRET ?? "dev-secret";
export const ADMIT_PER_SECOND = Number(process.env.ADMIT_PER_SECOND ?? 500);

@Controller("events/:eventId/queue")
export class QueueController {
  constructor(@Inject(QueueService) private readonly q: QueueService) {}

  @Post("join")
  join(@Param("eventId", ParseIntPipe) eventId: number, @Body() body: { userId: string }) {
    if (typeof body?.userId !== "string" || !body.userId) throw new BadRequestException("userId required");
    return this.q.join(eventId, body.userId);
  }

  @Get("status")
  async status(@Param("eventId", ParseIntPipe) eventId: number, @Query("userId") userId: string) {
    if (!userId) throw new BadRequestException("userId required");
    const st = await this.q.status(eventId, userId, ADMIT_PER_SECOND);
    return st.state === "admitted" ? { ...st, token: signAdmission(userId, eventId, st.ttl, ADMISSION_SECRET) } : st;
  }
}
