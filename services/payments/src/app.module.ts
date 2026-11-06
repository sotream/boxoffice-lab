import { Body, Controller, Module, Post } from "@nestjs/common";
import { createPool } from "./db";
import { PaymentsController } from "./payments.controller";
import { PaymentsService, StepTimeout } from "./payments.service";
import { FakePsp } from "./psp";

const pool = createPool(Number(process.env.PG_POOL ?? 20));
const psp = new FakePsp(Number(process.env.PSP_LATENCY_MS ?? 100), Number(process.env.PSP_FAIL_RATE ?? 0));
const inventoryUrl = process.env.INVENTORY_URL ?? "http://localhost:3101";

/** Drill hook (PSP_ADMIN=1 only): change the fake PSP latency at runtime to simulate a slow or recovering provider. */
@Controller("admin")
class AdminController {
  @Post("psp")
  set(@Body() b: { latencyMs: number }) {
    if (process.env.PSP_ADMIN !== "1") return { ok: false };
    psp.latencyMs = Number(b.latencyMs);
    return { ok: true, latencyMs: psp.latencyMs };
  }
}

@Module({
  controllers: [PaymentsController, AdminController],
  providers: [{
    provide: PaymentsService,
    useFactory: () => new PaymentsService(pool, psp, async (eventId, seatIds, userId) => {
      try {
        const res = await fetch(`${inventoryUrl}/events/${eventId}/confirm`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seatIds, userId }),
          signal: AbortSignal.timeout(Number(process.env.CONFIRM_TIMEOUT_MS ?? 2000))
        });
        if (res.status >= 500) throw new StepTimeout(`inventory ${res.status}`); // unknown outcome, not "seats lost"
        return res.ok;
      } catch (e) {
        if (e instanceof StepTimeout) throw e;
        throw new StepTimeout("inventory unreachable or timed out");
      }
    }, Number(process.env.PSP_TIMEOUT_MS ?? 2000))
  }]
})
export class AppModule {}
export { pool };
