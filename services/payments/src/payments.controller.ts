import { BadRequestException, Body, ConflictException, Controller, Headers, Inject, Post, Res } from "@nestjs/common";
import { IdempotencyKeyReused, PaymentsService } from "./payments.service";
import { finalResults, inProgress, stateLabel } from "./metrics";

/** 1 to 8 distinct positive int4 seat ids (and a positive int4 event id), checked before the card is charged: a value Postgres cannot store would fail at inventory only after the money moved. Duplicates are refused too: the price is seats x unit price, so [5,5,5] would bill one seat three times. */
const INT4_MAX = 2_147_483_647;
const isId = (x: unknown): x is number => Number.isInteger(x) && (x as number) > 0 && (x as number) <= INT4_MAX;
function validSeats(v: unknown): v is number[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= 8 && v.every(isId) && new Set(v).size === v.length;
}

/** `amountCents` is optional: the price is computed here. A client that still sends it must send exactly the computed value. */
interface Body_ { eventId: number; userId: string; seatIds: number[]; amountCents?: number }
export const SEAT_PRICE_CENTS = "SEAT_PRICE_CENTS";

@Controller("payments")
export class PaymentsController {
  constructor(
    @Inject(PaymentsService) private readonly svc: PaymentsService,
    /** Price of one seat in cents (env SEAT_PRICE_CENTS). The server decides what a purchase costs, never the request. */
    @Inject(SEAT_PRICE_CENTS) private readonly seatPriceCents: number
  ) {}

  @Post()
  async pay(@Headers("idempotency-key") key: string, @Body() b: Body_, @Res({ passthrough: true }) res: { status(code: number): unknown }) {
    if (!key) throw new BadRequestException("Idempotency-Key header required");
    if (!b || !isId(b.eventId) || typeof b.userId !== "string" || !validSeats(b.seatIds)) throw new BadRequestException("invalid body");
    const amountCents = b.seatIds.length * this.seatPriceCents;
    // A client-supplied amount is never used, only compared: a tampered price is rejected before anything is charged.
    if (b.amountCents !== undefined && b.amountCents !== amountCents) throw new BadRequestException(`amountCents does not match the price (${b.seatIds.length} seats x ${this.seatPriceCents} = ${amountCents})`);
    let r;
    try { r = await this.svc.pay({ idempotencyKey: key, eventId: b.eventId, userId: b.userId, seatIds: b.seatIds, amountCents }); }
    catch (e) { if (e instanceof IdempotencyKeyReused) throw new ConflictException(e.message); throw e; }
    // 202: accepted, outcome not final yet; retry with the same Idempotency-Key to read the result.
    if (r.kind === "in-progress") inProgress.inc(); else finalResults.inc({ status: stateLabel(r.payment.status) });
    res.status(r.kind === "in-progress" ? 202 : 200);
    return { status: r.payment.status, paymentId: r.payment.id, inProgress: r.kind === "in-progress" };
  }
}
