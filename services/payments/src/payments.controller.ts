import { BadRequestException, Body, Controller, Headers, Inject, Post, Res } from "@nestjs/common";
import { PaymentsService } from "./payments.service";
import { finalResults, inProgress, stateLabel } from "./metrics";

/** 1 to 8 positive int4 seat ids (and a positive int4 event id), checked before the card is charged: a value Postgres cannot store would fail at inventory only after the money moved. */
const INT4_MAX = 2_147_483_647;
const isId = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0 && (x as number) <= INT4_MAX;
function validSeats(v: unknown): v is number[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= 8 && v.every(isId);
}

interface Body_ { eventId: number; userId: string; seatIds: number[]; amountCents: number }

@Controller("payments")
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly svc: PaymentsService) {}

  @Post()
  async pay(@Headers("idempotency-key") key: string, @Body() b: Body_, @Res({ passthrough: true }) res: { status(code: number): unknown }) {
    if (!key) throw new BadRequestException("Idempotency-Key header required");
    if (!b || !isId(b.eventId) || typeof b.userId !== "string" || !validSeats(b.seatIds) || !Number.isInteger(b.amountCents) || b.amountCents <= 0) {
      throw new BadRequestException("invalid body");
    }
    const r = await this.svc.pay({ idempotencyKey: key, ...b });
    // 202: accepted, outcome not final yet; retry with the same Idempotency-Key to read the result.
    if (r.kind === "in-progress") inProgress.inc(); else finalResults.inc({ status: stateLabel(r.payment.status) });
    res.status(r.kind === "in-progress" ? 202 : 200);
    return { status: r.payment.status, paymentId: r.payment.id, inProgress: r.kind === "in-progress" };
  }
}
