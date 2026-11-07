import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/faults/**", "node_modules/**"], // docker-based fault scenarios have their own config (vitest.faults.config.ts)
    fileParallelism: false, // one stack of real processes at a time
    testTimeout: 150_000,
    hookTimeout: 90_000
  }
});
