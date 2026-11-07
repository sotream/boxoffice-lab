import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { confirmSeatsOverHttp } from "./confirm-seats";
import { PaymentsController } from "./payments.controller";
import { StepTimeout } from "./payments.service";

let server: Server;
let url = "";
let status = 200;
let delayMs = 0;
beforeAll(async () => {
  server = createServer((_req, res) => { setTimeout(() => { res.statusCode = status; res.end("{}"); }, delayMs); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const confirm = (timeoutMs = 500) => confirmSeatsOverHttp(url, timeoutMs)(1, [1, 2], "u");

describe("confirmSeatsOverHttp: what each inventory answer means for the saga", () => {
  it("2xx means sold", async () => { status = 201; delayMs = 0; expect(await confirm()).toBe(true); });
  it("409 is the only answer that means the seats were lost", async () => { status = 409; expect(await confirm()).toBe(false); });
  it("5xx is an unknown outcome, never a refund", async () => { status = 503; await expect(confirm()).rejects.toBeInstanceOf(StepTimeout); });
  it("a timeout is an unknown outcome", async () => { status = 201; delayMs = 300; await expect(confirm(50)).rejects.toBeInstanceOf(StepTimeout); delayMs = 0; });
  it("an unreachable inventory is an unknown outcome", async () => {
    await expect(confirmSeatsOverHttp("http://127.0.0.1:1", 200)(1, [1], "u")).rejects.toBeInstanceOf(StepTimeout);
  });
  it.each([400, 403, 404])("%i is a contract bug: neither a refund nor a retry-as-slow", async (s) => {
    status = s; delayMs = 0;
    const e = await confirm().catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(StepTimeout);
  });
});

describe("payments controller rejects bad seat lists before any charge", () => {
  const ctrl = new PaymentsController({ pay: async () => { throw new Error("must not be reached"); } } as never);
  const res = { status: () => undefined };
  const body = (seatIds: unknown) => ({ eventId: 1, userId: "u", seatIds: seatIds as number[], amountCents: 100 });
  it.each([[[]], [[1, 2, 3, 4, 5, 6, 7, 8, 9]], [[0]], [[-1]], [[1.5]], [["1"]], ["1,2"], [[3_000_000_000]], [[2_147_483_648]]])("%j is a 400", async (ids) => {
    await expect(ctrl.pay("k", body(ids), res)).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each([0, -1, 3_000_000_000, 1.5])("an event id of %j is a 400 as well", async (eventId) => {
    await expect(ctrl.pay("k", { ...body([1]), eventId }, res)).rejects.toBeInstanceOf(BadRequestException);
  });
});
