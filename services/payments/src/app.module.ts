import { Body, Controller, Module, Post } from "@nestjs/common";
import { registerPoolMetrics } from "@boxoffice/platform";
import { createPool } from "./db";
import { PaymentsController, SEAT_PRICE_CENTS } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { confirmSeatsOverHttp } from "./confirm-seats";
import { FakePsp } from "./psp";

const pool = createPool(Number(process.env.PG_POOL ?? 20));
registerPoolMetrics(pool, "main");
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
  providers: [{ provide: SEAT_PRICE_CENTS, useFactory: () => Number(process.env.SEAT_PRICE_CENTS ?? 5000) }, {
    provide: PaymentsService,
    useFactory: () => new PaymentsService(pool, psp, confirmSeatsOverHttp(inventoryUrl, Number(process.env.CONFIRM_TIMEOUT_MS ?? 2000)), Number(process.env.PSP_TIMEOUT_MS ?? 2000))
  }]
})
export class AppModule {}
export { pool };
