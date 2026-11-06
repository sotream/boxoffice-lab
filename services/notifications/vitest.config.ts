import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false, // the existing handler tests TRUNCATE the deliveries table, so files must not overlap
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "dist/**", "src/main.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 80, branches: 80, functions: 85, lines: 83 }
    }
  }
});
