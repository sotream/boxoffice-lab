import { BadRequestException, Body, Controller, Headers, HttpCode, Inject, Post } from "@nestjs/common";
import { PaymentsService } from "./payments.service";

interface Body_ { eventId: number; userId: string; seatIds: number[]; amountCents: number }

@Controller("payments")
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly svc: PaymentsService) {}

  @Post()
  @HttpCode(200)
  async pay(@Headers("idempotency-key") key: string, @Body() b: Body_) {
    if (!key) throw new BadRequestException("Idempotency-Key header required");
    if (!b || !Number.isInteger(b.eventId) || typeof b.userId !== "string" || !Array.isArray(b.seatIds) || !Number.isInteger(b.amountCents) || b.amountCents <= 0) {
      throw new BadRequestException("invalid body");
    }
    const r = await this.svc.pay({ idempotencyKey: key, ...b });
    return { status: r.payment.status, paymentId: r.payment.id, inProgress: r.kind === "in-progress" };
  }
}
