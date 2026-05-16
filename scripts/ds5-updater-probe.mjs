#!/usr/bin/env node
// DS5 verification probe — end-to-end proof that:
//
//   1. `window.nimbusShell.__version === "ds5"` (preload contract).
//   2. `window.nimbusShell.updater.onStateChange` subscribes and receives
//      the full `checking → available → downloading → downloaded` state
//      sequence as the main process forwards `electron-updater` events
//      over the DS3 origin-checked router.
//   3. `window.nimbusShell.updater.checkForUpdates()` round-trips through
//      the IPC seam without being rejected by the origin validator.
//   4. The updater controller pinned `autoDownload=true` and
//      `autoInstallOnAppQuit=true` (read back from the injected
//      mock auto-updater after init).
//
// Drives a mocked `autoUpdater` injected when the shell sees
// `NIMBUS_DESKTOP_UPDATER_MOCK=1`. The signed-release round-trip
// against a real GitHub Release rides on DS8 (signing) + DS9
// (release CI); DS5 covers the wiring contract end-to-end.
//
// Exit codes:
//   0 — all checks pass
//   1 — at least one assertion failed
//   2 — setup error

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { _electron as electron } from "playwright";

const ENTRY = resolve("./dist/main/index.js");
const SCREENSHOT_PATH = resolve("./.playwright-cli/ds5-probe.png");
const EXPECTED_ORIGIN = "http://127.0.0.1:";

let app;
let exitCode = 0;
const checks = {};
function record(name, value) {
  checks[name] = value;
}

try {
  await mkdir(dirname(SCREENSHOT_PATH), { recursive: true });

  app = await electron.launch({
    args: [ENTRY],
    timeout: 60_000,
    env: {
      ...process.env,
      NIMBUS_DESKTOP_UPDATER_MOCK: "1",
    },
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

  const probe = await win.evaluate(() => ({
    href: location.href,
    processType: typeof globalThis.process,
    shellExists: typeof globalThis.nimbusShell !== "undefined",
    shellVersion: globalThis.nimbusShell?.__version,
    shellFrozen:
      typeof globalThis.nimbusShell !== "undefined" &&
      Object.isFrozen(globalThis.nimbusShell),
    updaterNamespace: typeof globalThis.nimbusShell?.updater,
    updaterOnStateChangeType:
      typeof globalThis.nimbusShell?.updater?.onStateChange,
    updaterCheckForUpdatesType:
      typeof globalThis.nimbusShell?.updater?.checkForUpdates,
    updaterFrozen:
      typeof globalThis.nimbusShell?.updater !== "undefined" &&
      Object.isFrozen(globalThis.nimbusShell.updater),
  }));
  console.log("DS5 probe — observed:", JSON.stringify(probe, null, 2));

  record("url_loopback", String(url).startsWith(EXPECTED_ORIGIN));
  record("url_under_ui", String(url).includes("/ui/"));
  record("sandbox_no_process", probe.processType === "undefined");
  record("bridge_exists", probe.shellExists === true);
  record("bridge_version_ds5", probe.shellVersion === "ds5");
  record("bridge_frozen", probe.shellFrozen === true);
  record("updater_namespace", probe.updaterNamespace === "object");
  record("updater_frozen", probe.updaterFrozen === true);
  record(
    "updater_onStateChange_callable",
    probe.updaterOnStateChangeType === "function",
  );
  record(
    "updater_checkForUpdates_callable",
    probe.updaterCheckForUpdatesType === "function",
  );

  // Wire a renderer-side accumulator BEFORE driving the mock so we
  // never miss an event due to subscription timing.
  await win.evaluate(() => {
    /** @type {any} */ (window).__nimbusUpdaterEvents = [];
    /** @type {any} */ (window).__nimbusUpdaterUnsub = window.nimbusShell.updater.onStateChange(
      (change) => {
        /** @type {any} */ (window).__nimbusUpdaterEvents.push(change);
      },
    );
  });

  // Assert the mock-injection seam exposed the test handle in main.
  const mockProbe = await app.evaluate(() => ({
    hasMock: typeof globalThis.__nimbusTestAutoUpdater !== "undefined",
    autoDownload: globalThis.__nimbusTestAutoUpdater?.autoDownload,
    autoInstallOnAppQuit:
      globalThis.__nimbusTestAutoUpdater?.autoInstallOnAppQuit,
  }));
  console.log("DS5 probe — mock probe:", mockProbe);
  record("mock_injected", mockProbe.hasMock === true);
  record("autoDownload_pinned_true", mockProbe.autoDownload === true);
  record(
    "autoInstallOnAppQuit_pinned_true",
    mockProbe.autoInstallOnAppQuit === true,
  );

  // Drive the renderer→main `checkForUpdates` invocation. This
  // proves the renderer-bound bridge call passes the DS3 origin check
  // and resolves cleanly (a foreign senderFrame would surface as a
  // rejected promise here).
  const checkResult = await win.evaluate(async () => {
    try {
      await window.nimbusShell.updater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      return { ok: false, err: String(err) };
    }
  });
  console.log("DS5 probe — checkForUpdates result:", checkResult);
  record("checkForUpdates_round_trip", checkResult.ok === true);

  // Drive the scripted state sequence through the injected mock.
  // Each emit fires the corresponding `electron-updater` event from
  // the main process, the updater controller translates it to a
  // `UpdaterStateChange`, and main `webContents.send`s it over the
  // `nimbus:updater:state-changed` channel to the renderer.
  await app.evaluate(() => {
    const mock = /** @type {any} */ (globalThis.__nimbusTestAutoUpdater);
    mock.emit("checking-for-update");
    mock.emit("update-available", { version: "1.2.3", releaseNotes: "test" });
    mock.emit("download-progress", {
      bytesPerSecond: 2048,
      percent: 50,
      transferred: 1024,
      total: 2048,
    });
    mock.emit("update-downloaded", { version: "1.2.3", releaseNotes: "test" });
  });

  // Allow the cross-process send + microtask drain.
  await new Promise((r) => setTimeout(r, 300));

  const received = await win.evaluate(
    () => /** @type {any} */ (window).__nimbusUpdaterEvents,
  );
  console.log("DS5 probe — received states:", JSON.stringify(received, null, 2));

  record("received_count_4", Array.isArray(received) && received.length === 4);
  record(
    "received_state_sequence",
    Array.isArray(received) &&
      received.length === 4 &&
      received[0]?.state === "checking" &&
      received[1]?.state === "available" &&
      received[2]?.state === "downloading" &&
      received[3]?.state === "downloaded",
  );
  record(
    "available_carries_version",
    Array.isArray(received) && received[1]?.version === "1.2.3",
  );
  record(
    "downloading_carries_progress",
    Array.isArray(received) &&
      received[2]?.progress?.percent === 50 &&
      received[2]?.progress?.transferred === 1024 &&
      received[2]?.progress?.total === 2048,
  );
  record(
    "downloaded_carries_version",
    Array.isArray(received) && received[3]?.version === "1.2.3",
  );

  // Unsubscribe + emit one more — assert it does not arrive.
  await win.evaluate(() => {
    /** @type {any} */ (window).__nimbusUpdaterUnsub();
  });
  await app.evaluate(() => {
    /** @type {any} */ (globalThis.__nimbusTestAutoUpdater).emit(
      "error",
      new Error("post-unsub"),
    );
  });
  await new Promise((r) => setTimeout(r, 200));
  const finalCount = await win.evaluate(
    () => /** @type {any} */ (window).__nimbusUpdaterEvents.length,
  );
  record("unsubscribe_stops_delivery", finalCount === 4);

  try {
    await win.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
  } catch (e) {
    console.warn("screenshot capture failed (non-fatal):", e?.message);
  }
} catch (err) {
  console.error("DS5 probe setup error:", err?.stack ?? err);
  exitCode = 2;
} finally {
  if (app) {
    try {
      await app.close();
    } catch {}
  }
}

console.log("DS5 probe — checks:", JSON.stringify(checks, null, 2));
const allPass = Object.values(checks).every(Boolean);
if (!allPass) {
  const failing = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  console.error("DS5 probe FAILED — failing checks:", failing.join(", "));
  exitCode = exitCode || 1;
} else {
  console.log(
    `DS5 probe — all ${Object.keys(checks).length} checks pass, screenshot at ${SCREENSHOT_PATH}`,
  );
}

process.exit(exitCode);
