import { defineConfig } from "vitest/config";

/** The fault suite: private docker containers, outages and crashes. Run with `pnpm test:e2e:faults` (needs the docker CLI). */
export default defineConfig({
  test: {
    include: ["src/faults/**/*.fault.test.ts"],
    globalSetup: ["src/faults/global-setup.ts"],
    fileParallelism: false, // one private world at a time
    testTimeout: 240_000,
    hookTimeout: 180_000
  }
});
