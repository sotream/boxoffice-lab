import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "dist/**", "src/main.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 }
    }
  }
});
