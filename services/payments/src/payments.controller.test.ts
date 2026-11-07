import { BadRequestException, ConflictException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { PaymentsController } from "./payments.controller";
import { IdempotencyKeyReused, PaymentRequest, PaymentsService } from "./payments.service";

const PRICE = 1234;
/** The controller with a service that records what it was asked to charge. */
function build(pay?: (r: PaymentRequest) => Promise<unknown>) {
  const seen: PaymentRequest[] = [];
  const svc = { pay: async (r: PaymentRequest) => { seen.push(r); return pay ? pay(r) : { kind: "done", payment: { id: 1, status: "CONFIRMED" } }; } } as unknown as PaymentsService;
  let status = 0;
  const res = { status: (c: number) => { status = c; } };
  const ctrl = new PaymentsController(svc, PRICE);
  return { seen, call: (key: string, body: unknown) => ctrl.pay(key, body as any, res), status: () => status };
}
const body = (over: Record<string, unknown> = {}) => ({ eventId: 1, userId: "u1", seatIds: [1, 2, 3], ...over });

describe("server-side price", () => {
  it("charges seats x SEAT_PRICE_CENTS when the body carries no amount", async () => {
    const { seen, call } = build();
    await call("k", body());
    expect(seen).toHaveLength(1);
    expect(seen[0].amountCents).toBe(3 * PRICE);
  });

  it("accepts a body whose amountCents equals the computed value (existing clients keep working)", async () => {
    const { seen, call } = build();
    await call("k", body({ amountCents: 3 * PRICE }));
    expect(seen[0].amountCents).toBe(3 * PRICE);
  });

  it("rejects any other amountCents with 400 before the service (and the card) is touched", async () => {
    for (const amountCents of [1, 0, -5, 3 * PRICE - 1, 3 * PRICE + 1, 1.5, "3702", null, NaN, [3 * PRICE]]) {
      const { seen, call } = build();
      await expect(call("k", body({ amountCents })), String(amountCents)).rejects.toBeInstanceOf(BadRequestException);
      expect(seen, String(amountCents)).toEqual([]);
    }
  });

  it("the amount follows the number of seats, not the other way round", async () => {
    const { seen, call } = build();
    await call("k1", body({ seatIds: [5] }));
    await call("k2", body({ seatIds: [1, 2, 3, 4, 5, 6, 7, 8] }));
    expect(seen.map((r) => r.amountCents)).toEqual([PRICE, 8 * PRICE]);
    const { call: c2 } = build();
    await expect(c2("k", body({ seatIds: [5], amountCents: 8 * PRICE }))).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("request validation (unchanged rules)", () => {
  it("requires the Idempotency-Key and a valid body", async () => {
    const { seen, call } = build();
    await expect(call("", body())).rejects.toBeInstanceOf(BadRequestException);
    for (const b of [null, {}, body({ eventId: 0 }), body({ userId: 5 }), body({ seatIds: [] }), body({ seatIds: [1, 2, 3, 4, 5, 6, 7, 8, 9] }), body({ seatIds: [0] })]) {
      await expect(call("k", b)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(seen).toEqual([]);
  });
});

describe("duplicate seat ids", () => {
  it("are a 400 before the service (and the card) is touched: one seat is never priced several times", async () => {
    for (const seatIds of [[5, 5, 5], [1, 2, 1], [3, 3]]) {
      const { seen, call } = build();
      await expect(call("k", body({ seatIds })), JSON.stringify(seatIds)).rejects.toBeInstanceOf(BadRequestException);
      expect(seen, JSON.stringify(seatIds)).toEqual([]);
    }
  });
});

describe("idempotency key scoping", () => {
  it("a key reused with a different request is a 409 that says nothing about the stored payment", async () => {
    const { call } = build(async () => { throw new IdempotencyKeyReused(); });
    const err = await call("k", body()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getStatus()).toBe(409);
    expect(err.message).toBe("idempotency key reused with a different request");
    expect(Object.keys(err.getResponse() as object).sort()).toEqual(["error", "message", "statusCode"]); // no payment id, status or user
  });
  it("other errors are not turned into 409", async () => {
    const { call } = build(async () => { throw new Error("db down"); });
    await expect(call("k", body())).rejects.toThrow("db down");
  });
});
