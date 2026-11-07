import { createServer, Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { verifyInternalRequest } from "@boxoffice/platform";
import { confirmSeatsOverHttp, verifyHoldsOverHttp } from "./confirm-seats";
import { PaymentsController } from "./payments.controller";
import { StepTimeout } from "./payments.service";

let server: Server;
let url = "";
let status = 200;
let delayMs = 0;
const KEY = "inventory-key";
/** Every request the fake inventory received, with whether its `x-internal-auth` verifies against the key it was given. */
const seen: { method: string; path: string; body: string; header: unknown; valid: boolean; headers: Record<string, unknown> }[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const path = (req.url ?? "").split("?", 1)[0];
      const header = req.headers["x-internal-auth"];
      seen.push({ method: req.method ?? "", path, body: body.toString(), header, valid: verifyInternalRequest(header, [KEY], req.method ?? "", path, body), headers: req.headers });
      setTimeout(() => { res.statusCode = status; res.end("{}"); }, delayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const confirm = (timeoutMs = 500) => confirmSeatsOverHttp(url, timeoutMs, KEY)(1, [1, 2], "u");

describe("confirmSeatsOverHttp: what each inventory answer means for the saga", () => {
  it("2xx means sold", async () => { status = 201; delayMs = 0; expect(await confirm()).toBe(true); });
  it("409 is the only answer that means the seats were lost", async () => { status = 409; expect(await confirm()).toBe(false); });
  it("5xx is an unknown outcome, never a refund", async () => { status = 503; await expect(confirm()).rejects.toBeInstanceOf(StepTimeout); });
  it("a timeout is an unknown outcome", async () => { status = 201; delayMs = 300; await expect(confirm(50)).rejects.toBeInstanceOf(StepTimeout); delayMs = 0; });
  it("an unreachable inventory is an unknown outcome", async () => {
    await expect(confirmSeatsOverHttp("http://127.0.0.1:1", 200, KEY)(1, [1], "u")).rejects.toBeInstanceOf(StepTimeout);
  });
  it.each([400, 403, 404])("%i is a contract bug: neither a refund nor a retry-as-slow", async (s) => {
    status = s; delayMs = 0;
    const e = await confirm().catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(StepTimeout);
  });
});

describe("payments controller rejects bad seat lists before any charge", () => {
  const ctrl = new PaymentsController({ pay: async () => { throw new Error("must not be reached"); } } as never, 100); // priced by the server, so only the id rules can reject the bodies below
  const res = { status: () => undefined };
  const body = (seatIds: unknown) => ({ eventId: 1, userId: "u", seatIds: seatIds as number[] }); // no amount: the price check must not be what rejects these
  it.each([[[]], [[1, 2, 3, 4, 5, 6, 7, 8, 9]], [[0]], [[-1]], [[1.5]], [["1"]], ["1,2"], [[3_000_000_000]], [[2_147_483_648]], [[5, 5, 5]], [[1, 2, 1]]])("%j is a 400", async (ids) => {
    await expect(ctrl.pay("k", body(ids), res)).rejects.toBeInstanceOf(BadRequestException);
  });
  it.each([0, -1, 3_000_000_000, 1.5])("an event id of %j is a 400 as well", async (eventId) => {
    await expect(ctrl.pay("k", { ...body([1]), eventId }, res)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("verifyHoldsOverHttp: the pre-charge question", () => {
  const verify = (timeoutMs = 500) => verifyHoldsOverHttp(url, timeoutMs, KEY)(1, [1, 2], "u");
  it("2xx means the payer holds the seats", async () => { status = 200; delayMs = 0; expect(await verify()).toBe(true); });
  it("409 means they do not: the one answer that stops the payment before the charge", async () => { status = 409; expect(await verify()).toBe(false); });
  it("5xx, a timeout and an unreachable inventory are unknown, never 'not held'", async () => {
    status = 503; delayMs = 0; await expect(verify()).rejects.toBeInstanceOf(StepTimeout);
    status = 200; delayMs = 300; await expect(verify(50)).rejects.toBeInstanceOf(StepTimeout); delayMs = 0;
    await expect(verifyHoldsOverHttp("http://127.0.0.1:1", 200, KEY)(1, [1], "u")).rejects.toBeInstanceOf(StepTimeout);
  });
  it.each([400, 403, 404])("%i is a contract bug: not 'not held' and not retried as slow", async (s) => {
    status = s; delayMs = 0;
    const e = await verify().catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(StepTimeout);
  });
});

describe("payments signs its calls to inventory with inventory's key", () => {
  it("confirm and holds/verify carry a signature over the exact method, path and body; the key itself is never sent", async () => {
    status = 201; delayMs = 0; seen.length = 0;
    await confirmSeatsOverHttp(url, 500, KEY)(7, [3, 4], "u9");
    status = 200;
    await verifyHoldsOverHttp(url, 500, KEY)(7, [3, 4], "u9");
    expect(seen.map((r) => [r.method, r.path, r.body, r.valid])).toEqual([
      ["POST", "/events/7/confirm", '{"seatIds":[3,4],"userId":"u9"}', true],
      ["POST", "/events/7/holds/verify", '{"seatIds":[3,4],"userId":"u9"}', true]
    ]);
    for (const r of seen) expect(JSON.stringify(r.headers) + r.body).not.toContain(KEY);
  });

  it("a signature made with another key is not valid at inventory (payments' own key and inventory's key are separate)", async () => {
    status = 201; delayMs = 0; seen.length = 0;
    await confirmSeatsOverHttp(url, 500, "payments-own-key")(7, [1], "u");
    expect(seen[0].valid).toBe(false);
  });
});
