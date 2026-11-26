import { defineConfig } from "vitest/config";

/**
 * End-to-end tests against the built app through tauri-driver (CI-04). Separate from the unit
 * suite: `npm run test` never collects these (they are `*.e2e.ts`, outside the default pattern).
 * One app at a time: each test starts and quits its own Kai window.
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    environment: "node",
    globalSetup: ["e2e/globalSetup.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
    // beforeEach starts the app (up to 3 bounded attempts, e2e/webdriver.ts) and then waits for
    // the terminal; globalSetup's warm-up launch gets its own, longer allowance.
    hookTimeout: 300_000,
  },
});
