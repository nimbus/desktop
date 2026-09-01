#!/usr/bin/env node
// DS2 browser-driven verification probe.
//
// Launches the built Electron app via Playwright's _electron API. Asserts:
//   - the shell discovers or starts Nimbus and the renderer reaches the
//     server's loopback /ui/ URL. A desktop-owned server uses an ephemeral
//     port, so the probe must not assume Nimbus's conventional port.
//   - `typeof process` is "undefined" in the renderer (sandbox proof)
//   - `window.nimbusShell.__version === "ds5"` (bridge still wired
//     after the URL flip; sandbox + bridge regressions are caught)
//   - `window.nimbusShell` is frozen
//
// Captures a screenshot to `.playwright-cli/ds2-probe.png`.
//
// Exits 0 on success, 1 on assertion failure, 2 on setup failure.

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { _electron as electron } from "playwright";

const ENTRY = resolve("./dist/main/index.js");
const SCREENSHOT_PATH = resolve("./.playwright-cli/ds2-probe.png");
let app;
let exitCode = 0;
try {
  await mkdir(dirname(SCREENSHOT_PATH), { recursive: true });

  app = await electron.launch({
    args: [ENTRY],
    timeout: 60_000,
  });

  app.process().stderr?.on("data", (b) => {
    process.stderr.write(`[electron-stderr] ${b.toString()}`);
  });
  app.process().stdout?.on("data", (b) => {
    process.stdout.write(`[electron-stdout] ${b.toString()}`);
  });

  const win = await app.firstWindow({ timeout: 60_000 });
  await win.waitForLoadState("domcontentloaded", { timeout: 60_000 });
  const url = win.url();
  const rendererUrl = new URL(url);

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
    url_loopback:
      rendererUrl.protocol === "http:" &&
      rendererUrl.hostname === "127.0.0.1" &&
      rendererUrl.port.length > 0,
    url_under_ui: rendererUrl.pathname.startsWith("/ui/"),
    url_matches_renderer: probe.location === url,
    sandbox_no_process: probe.processType === "undefined",
    sandbox_no_require: probe.requireType === "undefined",
    sandbox_no_buffer: probe.bufferType === "undefined",
    bridge_exists: probe.shellExists,
    bridge_version: probe.shellVersion === "ds5",
    bridge_frozen: probe.shellFrozen === true,
  };

  try {
    await win.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
  } catch (e) {
    console.warn("screenshot capture failed (non-fatal):", e?.message);
  }

  console.log("DS2 probe — renderer URL:", url);
  console.log("DS2 probe — observed:", JSON.stringify(probe, null, 2));
  console.log("DS2 probe — checks:", JSON.stringify(checks, null, 2));
  console.log("DS2 probe — screenshot:", SCREENSHOT_PATH);

  const allPass = Object.values(checks).every(Boolean);
  if (!allPass) {
    const failing = Object.entries(checks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    console.error("DS2 probe FAILED — failing checks:", failing.join(", "));
    exitCode = 1;
  } else {
    console.log("DS2 probe — ALL CHECKS PASSED");
  }
} catch (err) {
  console.error("DS2 probe setup error:", err?.stack ?? err);
  exitCode = 2;
} finally {
  if (app) {
    try {
      await app.close();
    } catch {}
  }
}

process.exit(exitCode);
