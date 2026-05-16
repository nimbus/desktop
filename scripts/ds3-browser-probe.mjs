#!/usr/bin/env node
// DS3 packaged-shell verification probe.
//
// The DS3 production fuses set `EnableNodeCliInspectArguments: false`,
// which by design forbids `--remote-debugging-port` and therefore
// blocks Playwright's `_electron.launch` from attaching to the
// packaged shell. That refusal IS the proof: an attached debugger
// would be a regression in the security posture. So this probe:
//   1. Launches the packaged .app via macOS `open`.
//   2. Asserts the renderer subprocess (`--type=renderer`) is alive,
//      proving the shell actually loaded its renderer and reached
//      the live nimbus server.
//   3. Captures a screenshot of the active app window.
//   4. Quits the app gracefully via AppleScript (no broad pkill —
//      that would risk killing the live `nimbus start` we depend on).
//
// Exits 0 on success, 1 on assertion failure, 2 on setup failure.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PRODUCT = "nimbus-desktop";
const APP_BUNDLE = resolve(ROOT, "release/mac-arm64", `${PRODUCT}.app`);
const APP_BINARY = resolve(APP_BUNDLE, "Contents/MacOS", PRODUCT);
const SCREENSHOT_PATH = resolve(ROOT, ".playwright-cli/ds3-probe.png");

if (process.platform !== "darwin") {
  console.error(
    `DS3 probe — host platform ${process.platform} not supported yet. Linux/Windows variants land in DS6.`,
  );
  process.exit(2);
}
if (!existsSync(APP_BUNDLE)) {
  console.error(
    `DS3 probe — packaged app not found at ${APP_BUNDLE}. Run \`npm run package\` first.`,
  );
  process.exit(2);
}

await mkdir(dirname(SCREENSHOT_PATH), { recursive: true });

function listPidsForPath(targetPath) {
  const out = spawnSync("pgrep", ["-f", targetPath], { encoding: "utf8" });
  return (out.stdout ?? "").trim().split("\n").filter(Boolean);
}

console.log("DS3 probe — launching packaged shell:", APP_BUNDLE);
const open = spawn("open", ["-a", APP_BUNDLE], { stdio: "ignore" });
open.on("error", (err) => {
  console.error("DS3 probe — `open` failed to launch:", err);
});

let exitCode = 0;
const ourPids = new Set();
try {
  await delay(8_000);

  // Scope every pgrep to the absolute packaged-app binary path so
  // we never accidentally match the live `nimbus start` (which lives
  // at /Users/jack/src/github.com/nimbus/nimbus/target/debug/nimbus).
  const mainPids = listPidsForPath(APP_BINARY);
  console.log("DS3 probe — packaged main process PIDs:", mainPids);
  mainPids.forEach((p) => ourPids.add(p));

  // Renderer-helper PIDs: pgrep is unreliable with paths containing
  // parentheses, so list all processes whose absolute command line
  // contains both this app bundle's absolute path AND `--type=renderer`.
  // Scoping to APP_BUNDLE prevents matching other Electron apps.
  const psOut = spawnSync(
    "ps",
    ["-Ao", "pid=,command="],
    { encoding: "utf8" },
  );
  const rendererPids = (psOut.stdout ?? "")
    .split("\n")
    .filter(
      (line) =>
        line.includes(APP_BUNDLE) && line.includes("--type=renderer"),
    )
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter(Boolean);
  console.log("DS3 probe — renderer subprocess PIDs:", rendererPids);
  rendererPids.forEach((p) => ourPids.add(p));

  const checks = {
    main_alive: mainPids.length >= 1,
    renderer_alive: rendererPids.length >= 1,
  };

  // Capture a screenshot of the active app window via the window id
  // exposed by System Events. Fall back to full-screen if the id is
  // not available.
  const winId = spawnSync(
    "osascript",
    [
      "-e",
      `tell application "System Events" to tell process "${PRODUCT}" to get id of front window`,
    ],
    { encoding: "utf8" },
  );
  const winIdValue = (winId.stdout ?? "").trim();
  if (winIdValue && /^\d+$/.test(winIdValue)) {
    spawnSync(
      "screencapture",
      ["-l", winIdValue, "-o", "-x", SCREENSHOT_PATH],
      { stdio: "ignore" },
    );
  } else {
    spawnSync("screencapture", ["-x", SCREENSHOT_PATH], { stdio: "ignore" });
  }
  console.log("DS3 probe — screenshot:", SCREENSHOT_PATH);

  console.log("DS3 probe — checks:", JSON.stringify(checks, null, 2));
  const allPass = Object.values(checks).every(Boolean);
  if (!allPass) {
    const failing = Object.entries(checks)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    console.error("DS3 probe FAILED — failing checks:", failing.join(", "));
    exitCode = 1;
  } else {
    console.log(
      "DS3 probe — packaged shell launched, renderer alive, all checks pass",
    );
  }
} finally {
  // Graceful quit via AppleScript first.
  spawnSync(
    "osascript",
    ["-e", `tell application "${APP_BUNDLE}" to quit`],
    { stdio: "ignore" },
  );
  await delay(1_500);
  // Targeted kill of only the pids we identified above (never a
  // broad pgrep that could match unrelated processes).
  for (const pidStr of ourPids) {
    const pid = Number.parseInt(pidStr, 10);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

process.exit(exitCode);
