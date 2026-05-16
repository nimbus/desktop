import { defineConfig } from "@playwright/test";

// DS7 packaged-shell E2E. Specs spawn the packaged Electron binary
// out-of-band (via child_process) and attach Playwright over CDP, so
// the default `use.baseURL` / `webServer` hooks do not apply — each
// spec sets up its own server scaffold via tests/e2e/helpers.
//
// `--remote-debugging-port` works on the production-fused build:
// `EnableNodeCliInspectArguments: false` blocks Node's `--inspect`
// but does NOT block Chromium's renderer CDP. See DS7 execution log.
//
// Traces are written to `test-results/` per spec — CI uploads them
// only on failure. `forbidOnly` keeps `test.only` out of CI runs.

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  use: {
    trace: "on-first-retry",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
