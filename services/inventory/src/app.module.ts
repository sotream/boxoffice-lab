import { Module } from "@nestjs/common";
import { registerPoolMetrics } from "@boxoffice/platform";
import { InventoryController } from "./inventory.controller";
import { InventoryService, PG } from "./inventory.service";
import { createPool } from "./db";

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, { provide: PG, useFactory: () => { const p = createPool(); registerPoolMetrics(p, "main"); return p; } }]
})
export class AppModule {}
