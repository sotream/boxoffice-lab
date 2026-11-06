import { Module } from "@nestjs/common";
import { createPool } from "./db";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { FakePsp } from "./psp";

const pool = createPool(Number(process.env.PG_POOL ?? 20));
const psp = new FakePsp(Number(process.env.PSP_LATENCY_MS ?? 100), Number(process.env.PSP_FAIL_RATE ?? 0));
const inventoryUrl = process.env.INVENTORY_URL ?? "http://localhost:3101";

@Module({
  controllers: [PaymentsController],
  providers: [{
    provide: PaymentsService,
    useFactory: () => new PaymentsService(pool, psp, async (eventId, seatIds, userId) => {
      const res = await fetch(`${inventoryUrl}/events/${eventId}/confirm`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seatIds, userId })
      });
      return res.ok;
    })
  }]
})
export class AppModule {}
export { pool };
