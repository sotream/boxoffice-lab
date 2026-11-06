import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false, // every file truncates payments.payments and payments.outbox
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "dist/**", "src/main.ts", "src/app.module.ts", "src/psp.contract.ts", "src/saga.*.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 74, branches: 72, functions: 57, lines: 80 }
    }
  }
});
