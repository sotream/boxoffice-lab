import { BadRequestException, Body, Controller, Get, Inject, Param, ParseIntPipe, Post, Query, Res, ServiceUnavailableException } from "@nestjs/common";
import { signAdmission } from "@boxoffice/admission";
import { QueueService } from "./queue.service";
import { isRedisUnavailable } from "./redis-unavailable";

export const ADMISSION_SECRET = process.env.ADMISSION_SECRET ?? "dev-secret";
export const ADMIT_PER_SECOND = Number(process.env.ADMIT_PER_SECOND ?? 500);

type Reply = { header(name: string, value: string): unknown };

/** Redis did not answer in time (see app.module): 503 + Retry-After, a bounded answer instead of a wait for the gateway's 8 s timeout. */
async function orUnavailable<T>(reply: Reply, work: Promise<T>): Promise<T> {
  try { return await work; } catch (e) {
    if (!isRedisUnavailable(e)) throw e;
    reply.header("retry-after", "1");
    throw new ServiceUnavailableException("queue store unavailable");
  }
}

@Controller("events/:eventId/queue")
export class QueueController {
  constructor(@Inject(QueueService) private readonly q: QueueService) {}

  @Post("join")
  join(@Param("eventId", ParseIntPipe) eventId: number, @Body() body: { userId: string }, @Res({ passthrough: true }) reply: Reply) {
    if (typeof body?.userId !== "string" || !body.userId) throw new BadRequestException("userId required");
    return orUnavailable(reply, this.q.join(eventId, body.userId));
  }

  @Get("status")
  async status(@Param("eventId", ParseIntPipe) eventId: number, @Query("userId") userId: string, @Res({ passthrough: true }) reply: Reply) {
    if (!userId) throw new BadRequestException("userId required");
    const st = await orUnavailable(reply, this.q.status(eventId, userId, ADMIT_PER_SECOND));
    return st.state === "admitted" ? { ...st, token: signAdmission(userId, eventId, st.ttl, ADMISSION_SECRET) } : st;
  }
}
