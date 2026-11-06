import { BadRequestException, Body, Controller, Headers, Inject, Post, Res } from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { finalResults, inProgress, stateLabel } from "./metrics";

interface Body_ { eventId: number; userId: string; seatIds: number[]; amountCents: number }

@Controller("payments")
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly svc: PaymentsService) {}

  @Post()
  async pay(@Headers("idempotency-key") key: string, @Body() b: Body_, @Res({ passthrough: true }) res: { status(code: number): unknown }) {
    if (!key) throw new BadRequestException("Idempotency-Key header required");
    if (!b || !Number.isInteger(b.eventId) || typeof b.userId !== "string" || !Array.isArray(b.seatIds) || !Number.isInteger(b.amountCents) || b.amountCents <= 0) {
      throw new BadRequestException("invalid body");
    }
    const r = await this.svc.pay({ idempotencyKey: key, ...b });
    // 202: accepted, outcome not final yet; retry with the same Idempotency-Key to read the result.
    if (r.kind === "in-progress") inProgress.inc(); else finalResults.inc({ status: stateLabel(r.payment.status) });
    res.status(r.kind === "in-progress" ? 202 : 200);
    return { status: r.payment.status, paymentId: r.payment.id, inProgress: r.kind === "in-progress" };
  }
}
