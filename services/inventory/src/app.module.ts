import { Module } from "@nestjs/common";
import { registerPoolMetrics } from "@boxoffice/platform";
import { InventoryController } from "./inventory.controller";
import { HOLD_SECONDS, HOLD_TTL, InventoryService, PG } from "./inventory.service";
import { createPool } from "./db";

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, { provide: HOLD_TTL, useFactory: () => Number(process.env.HOLD_SECONDS ?? HOLD_SECONDS) }, { provide: PG, useFactory: () => { const p = createPool(); registerPoolMetrics(p, "main"); return p; } }]
})
export class AppModule {}
