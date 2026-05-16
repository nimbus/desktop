#!/usr/bin/env node
// DS4 verification probe — proves three things end-to-end against
// the dev shell launched via Playwright's `_electron.launch`:
//
//   1. The renderer URL is the live nimbus server under /ui/ (DS2
//      regression check).
//   2. The contextBridge surface exposes the DS4 `nimbusShell.tray`
//      namespace with `setStatusDot` callable.
//   3. Window bounds persist across relaunch: the probe moves+resizes
//      the window, quits the shell, relaunches it, and asserts the
//      restored bounds match what was saved.
//
// Runs against the dev shell (dist/main/index.js) — not the packaged
// .app — because the DS3 fuses block Playwright's debugger attach on
// the packaged binary. That is by design; DS3's packaged-shell probe
// covers the fused launch path, and this DS4 probe focuses on the
// chrome behavior that is testable through the renderer surface.
//
// Exit codes:
//   0 — all checks pass
//   1 — at least one assertion failed
//   2 — setup error (Playwright not installed, build artifacts missing)

import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MAIN_PATH = resolve(ROOT, "dist/main/index.js");

if (!existsSync(MAIN_PATH)) {
  console.error(
    `DS4 probe — build artifact not found at ${MAIN_PATH}. Run \`npm run build:main\` first.`,
  );
  process.exit(2);
}

const USER_DATA = mkdtempSync(join(tmpdir(), "nimbus-ds4-userdata-"));
const SCREENSHOT_DIR = resolve(ROOT, ".playwright-cli");
const SCREENSHOT_PRE = join(SCREENSHOT_DIR, "ds4-probe-pre.png");
const SCREENSHOT_POST = join(SCREENSHOT_DIR, "ds4-probe-post.png");

const TARGET_BOUNDS = { x: 180, y: 220, width: 1100, height: 720 };

const checks = {};
let exitCode = 0;

function record(name, value) {
  checks[name] = value;
}

async function launch() {
  return electron.launch({
    args: [MAIN_PATH, `--user-data-dir=${USER_DATA}`],
    env: { ...process.env, ELECTRON_DISABLE_SANDBOX: "0" },
  });
}

async function readBounds(page) {
  // No direct evaluate hook into the main process from a renderer
  // page; we read the window-state.json that DS4's onBoundsChanged
  // wrote out.
  const fs = await import("node:fs/promises");
  const statePath = join(USER_DATA, "window-state.json");
  try {
    const raw = await fs.readFile(statePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function firstLaunch() {
  console.log("DS4 probe — first launch (resize + persist bounds)");
  const app = await launch();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded", { timeout: 60_000 });

    const probe = await win.evaluate(() => {
      const w = /** @type {any} */ (globalThis).window ?? globalThis;
      const shell = /** @type {any} */ (w).nimbusShell;
      return {
        href: location.href,
        processType: typeof globalThis.process,
        shellExists: typeof shell !== "undefined",
        shellVersion: shell?.__version,
        shellFrozen:
          typeof shell !== "undefined" && Object.isFrozen(shell),
        trayNamespace: typeof shell?.tray,
        traySetStatusDotType: typeof shell?.tray?.setStatusDot,
      };
    });
    console.log("DS4 probe — renderer probe:", probe);
    record("url_loopback", probe.href.startsWith("http://127.0.0.1:"));
    record("url_under_ui", probe.href.includes("/ui/"));
    record("sandbox_no_process", probe.processType === "undefined");
    record("bridge_exists", probe.shellExists === true);
    record("bridge_version_ds4", probe.shellVersion === "ds4");
    record("bridge_frozen", probe.shellFrozen === true);
    record("tray_namespace", probe.trayNamespace === "object");
    record(
      "tray_setStatusDot_callable",
      probe.traySetStatusDotType === "function",
    );

    // Drive the tray:setStatusDot IPC end-to-end. The renderer push
    // resolves once the main-process handler returns; an
    // IpcOriginRejection from a foreign senderFrame would surface as
    // a rejected promise here, so a successful resolve is the proof
    // that the DS3 origin-check accepts the loopback frame and DS4
    // wired the channel into the tray controller.
    const trayResult = await win.evaluate(async () => {
      const w = /** @type {any} */ (globalThis).window ?? globalThis;
      try {
        await w.nimbusShell.tray.setStatusDot("connected");
        return { ok: true };
      } catch (err) {
        return { ok: false, err: String(err) };
      }
    });
    console.log("DS4 probe — tray.setStatusDot result:", trayResult);
    record("tray_set_status_dot_round_trip", trayResult.ok === true);

    await win.screenshot({ path: SCREENSHOT_PRE });

    // Resize the OS window to the target bounds, then close. The
    // onBoundsChanged debounce is 250 ms — give it 500 ms to flush.
    const electronApp = app;
    await electronApp.evaluate(({ BrowserWindow }, bounds) => {
      const [w] = BrowserWindow.getAllWindows();
      if (w) {
        w.setBounds(bounds);
      }
    }, TARGET_BOUNDS);
    await new Promise((r) => setTimeout(r, 600));
  } finally {
    await app.close();
  }
  const persisted = await readBounds();
  console.log("DS4 probe — persisted bounds after first launch:", persisted);
  record(
    "bounds_persisted_to_disk",
    persisted !== null &&
      persisted.x === TARGET_BOUNDS.x &&
      persisted.y === TARGET_BOUNDS.y &&
      persisted.width === TARGET_BOUNDS.width &&
      persisted.height === TARGET_BOUNDS.height,
  );
}

async function secondLaunch() {
  console.log("DS4 probe — second launch (assert bounds restored)");
  const app = await launch();
  try {
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded", { timeout: 60_000 });
    const restored = await app.evaluate(({ BrowserWindow }) => {
      const [w] = BrowserWindow.getAllWindows();
      return w?.getBounds() ?? null;
    });
    console.log("DS4 probe — restored bounds after second launch:", restored);
    record(
      "bounds_restored_after_relaunch",
      restored !== null &&
        restored.x === TARGET_BOUNDS.x &&
        restored.y === TARGET_BOUNDS.y &&
        restored.width === TARGET_BOUNDS.width &&
        restored.height === TARGET_BOUNDS.height,
    );
    await win.screenshot({ path: SCREENSHOT_POST });
  } finally {
    await app.close();
  }
}

try {
  await firstLaunch();
  await secondLaunch();
} catch (error) {
  console.error("DS4 probe — unhandled error:", error);
  exitCode = 2;
} finally {
  // Always clean the temp user data directory so the next probe run
  // starts fresh.
  await rm(USER_DATA, { recursive: true, force: true });
}

console.log("DS4 probe — checks:", JSON.stringify(checks, null, 2));
const allPass = Object.values(checks).every(Boolean);
if (!allPass) {
  const failing = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  console.error("DS4 probe FAILED — failing checks:", failing.join(", "));
  exitCode = exitCode || 1;
} else {
  console.log(
    `DS4 probe — all ${Object.keys(checks).length} checks pass, screenshots at ${SCREENSHOT_PRE} + ${SCREENSHOT_POST}`,
  );
}

process.exit(exitCode);
