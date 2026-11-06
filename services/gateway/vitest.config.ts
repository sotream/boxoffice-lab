import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false, // the existing limiter tests clear every `rl:*` key, so test files must not overlap
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "dist/**", "src/main.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 95, branches: 82, functions: 85, lines: 95 }
    }
  }
});
