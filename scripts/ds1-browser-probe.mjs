#!/usr/bin/env node
// DS1 browser-driven verification probe.
//
// Launches the built Electron app via Playwright's _electron API,
// attaches to the renderer, and asserts:
//   - the renderer reaches the DS1 placeholder URL (https://example.org/)
//   - `typeof process` is "undefined" (sandbox proof)
//   - `window.nimbusShell.__version === "ds1"` (contextBridge proof)
//   - `window.nimbusShell` is frozen (immutable bridge surface)
//
// Captures a screenshot to `.playwright-cli/ds1-probe.png` so the
// execution-log row has visual evidence matching the rigor of DU6.5,
// DU7, DU8, DU9, DU11, and DS0A.
//
// Exits 0 on success, 1 on assertion failure, 2 on setup failure.

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { _electron as electron } from "playwright";

const PLACEHOLDER_URL = "https://example.org/";
const ENTRY = resolve("./dist/main/index.js");
const SCREENSHOT_PATH = resolve("./.playwright-cli/ds1-probe.png");

let app;
let exitCode = 0;
try {
  await mkdir(dirname(SCREENSHOT_PATH), { recursive: true });

  app = await electron.launch({
    args: [ENTRY],
    timeout: 30_000,
  });

  app.process().stderr?.on("data", (b) => {
    process.stderr.write(`[electron-stderr] ${b.toString()}`);
  });
  app.process().stdout?.on("data", (b) => {
    process.stdout.write(`[electron-stdout] ${b.toString()}`);
  });

  const win = await app.firstWindow({ timeout: 30_000 });
  await win.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  const url = win.url();

  const probe = await win.evaluate(() => ({
    processType: typeof globalThis.process,
    requireType: typeof globalThis.require,
    bufferType: typeof globalThis.Buffer,
    shellExists: typeof globalThis.nimbusShell !== "undefined",
    shellVersion: globalThis.nimbusShell?.__version,
    shellFrozen: Object.isFrozen(globalThis.nimbusShell),
    location: location.href,
  }));

  const checks = {
    url: url.startsWith(PLACEHOLDER_URL),
    sandbox_no_process: probe.processType === "undefined",
    sandbox_no_require: probe.requireType === "undefined",
    sandbox_no_buffer: probe.bufferType === "undefined",
    bridge_exists: probe.shellExists,
    bridge_version: probe.shellVersion === "ds4",
    bridge_frozen: probe.shellFrozen === true,
  };

  try {
    await win.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
  } catch (e) {
    console.warn("screenshot capture failed (non-fatal):", e?.message);
  }

  console.log("DS1 probe — renderer URL:", url);
  console.log("DS1 probe — observed:", JSON.stringify(probe, null, 2));
  console.log("DS1 probe — checks:", JSON.stringify(checks, null, 2));
  console.log("DS1 probe — screenshot:", SCREENSHOT_PATH);

  const allPass = Object.values(checks).every(Boolean);
  if (!allPass) {
    const failing = Object.entries(checks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    console.error("DS1 probe FAILED — failing checks:", failing.join(", "));
    exitCode = 1;
  } else {
    console.log("DS1 probe — ALL CHECKS PASSED");
  }
} catch (err) {
  console.error("DS1 probe setup error:", err?.stack ?? err);
  exitCode = 2;
} finally {
  if (app) {
    try {
      await app.close();
    } catch {}
  }
}

process.exit(exitCode);
