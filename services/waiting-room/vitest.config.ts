import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "dist/**", "src/main.ts", "src/app.module.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 90, branches: 90, functions: 80, lines: 90 }
    }
  }
});
