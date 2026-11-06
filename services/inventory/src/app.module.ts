import { Module } from "@nestjs/common";
import { InventoryController } from "./inventory.controller";
import { InventoryService, PG } from "./inventory.service";
import { createPool } from "./db";

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, { provide: PG, useFactory: () => createPool() }]
})
export class AppModule {}
