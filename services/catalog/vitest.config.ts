import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false, // seed() truncates catalog.events, so test files must not overlap
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "dist/**", "src/main.ts", "src/app.module.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 }
    }
  }
});
