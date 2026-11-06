import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false, // test files share one Postgres; sequential files keep them deterministic
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "dist/**", "src/main.ts", "src/app.module.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 80, branches: 90, functions: 78, lines: 85 }
    }
  }
});
