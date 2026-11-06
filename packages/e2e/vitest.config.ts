import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false, // one stack of real processes at a time
    testTimeout: 150_000,
    hookTimeout: 90_000
  }
});
