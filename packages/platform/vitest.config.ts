import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "dist/**", "src/index.ts", "src/testing.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { statements: 85, branches: 80, functions: 83, lines: 90 }
    }
  }
});
