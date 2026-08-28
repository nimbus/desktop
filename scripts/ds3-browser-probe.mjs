#!/usr/bin/env node
// DS3 packaged-shell verification probe.
//
// The DS3 production fuses set `EnableNodeCliInspectArguments: false`,
// which by design forbids `--remote-debugging-port` and therefore
// blocks Playwright's `_electron.launch` from attaching to the
// packaged shell. That refusal IS the proof: an attached debugger
// would be a regression in the security posture. So this probe:
//   1. Launches the packaged app binary directly with isolated HOME, TMPDIR,
//      Chromium user-data, and the caller's candidate-binary environment.
//   2. Asserts the renderer subprocess (`--type=renderer`) is alive,
//      proving the shell actually loaded its renderer and reached
//      the live nimbus server.
//   3. Captures a screenshot of the active app window.
//   4. Quits the exact process group gracefully (no broad pkill — that would
//      risk killing an unrelated `nimbus start`).
//
// Exits 0 on success, 1 on assertion failure, 2 on setup failure.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PRODUCT = "nimbus-desktop";
const APP_BUNDLE = resolve(ROOT, "release/mac-arm64", `${PRODUCT}.app`);
const APP_BINARY = resolve(APP_BUNDLE, "Contents/MacOS", PRODUCT);
const SCREENSHOT_PATH = resolve(ROOT, ".playwright-cli/ds3-probe.png");
const RENDERER_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 10_000;

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
const scratchRoot = await mkdtemp(join(tmpdir(), "nimbus-desktop-ds3-"));
const scratchTmp = join(scratchRoot, "tmp");
const userDataDir = join(scratchRoot, "userData");
const serverDiscoveryPath = join(scratchTmp, "nimbus", "server.json");
await mkdir(scratchTmp, { recursive: true });
await mkdir(userDataDir, { recursive: true });

function listPidsForPath(targetPath) {
  const out = spawnSync("pgrep", ["-f", targetPath], { encoding: "utf8" });
  return (out.stdout ?? "").trim().split("\n").filter(Boolean);
}

function processCommand(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

async function readSpawnedServer() {
  try {
    const record = JSON.parse(await readFile(serverDiscoveryPath, "utf8"));
    if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return null;
    const command = processCommand(record.pid);
    return command ? { pid: record.pid, command } : null;
  } catch {
    return null;
  }
}

async function waitForRecordedProcessExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processCommand(record.pid) !== record.command) return true;
    await delay(100);
  }
  return processCommand(record.pid) !== record.command;
}

function signalRecordedProcess(record, signal) {
  const failures = [];
  for (const target of [-record.pid, record.pid]) {
    try {
      process.kill(target, signal);
      return null;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : error;
      failures.push(`${target}:${String(code)}`);
    }
  }
  return `${signal} failed (${failures.join(", ")})`;
}

async function stopRecordedServer(record) {
  if (!record) {
    return {
      stopped: false,
      failures: ["spawned Nimbus discovery record was not observed"],
    };
  }
  if (processCommand(record.pid) !== record.command) {
    return { stopped: true, failures: [] };
  }
  const failures = [];
  const termFailure = signalRecordedProcess(record, "SIGTERM");
  if (termFailure) failures.push(termFailure);
  if (await waitForRecordedProcessExit(record, SHUTDOWN_GRACE_MS)) {
    return { stopped: true, failures };
  }
  const killFailure = signalRecordedProcess(record, "SIGKILL");
  if (killFailure) failures.push(killFailure);
  return {
    stopped: await waitForRecordedProcessExit(record, 2_000),
    failures,
  };
}

console.log("DS3 probe — launching packaged shell:", APP_BUNDLE);
const child = spawn(
  APP_BINARY,
  [
    `--user-data-dir=${userDataDir}`,
    "--use-mock-keychain",
    "--password-store=basic",
  ],
  {
    cwd: scratchRoot,
    detached: true,
    env: {
      ...process.env,
      HOME: scratchRoot,
      TMPDIR: scratchTmp,
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const logChunks = [];
child.stdout?.on("data", (chunk) => logChunks.push(chunk.toString("utf8")));
child.stderr?.on("data", (chunk) => logChunks.push(chunk.toString("utf8")));
let childExited = false;
child.once("exit", () => {
  childExited = true;
});

let exitCode = 0;
let spawnedServer = null;
try {
  let rendererPids = [];
  const deadline = Date.now() + RENDERER_TIMEOUT_MS;
  while (!childExited && Date.now() < deadline) {
    spawnedServer ??= await readSpawnedServer();
    const psOut = spawnSync("ps", ["-Ao", "pid=,command="], {
      encoding: "utf8",
    });
    rendererPids = (psOut.stdout ?? "")
      .split("\n")
      .filter(
        (line) =>
          line.includes(APP_BUNDLE) && line.includes("--type=renderer"),
      )
      .map((line) => line.trim().split(/\s+/, 1)[0])
      .filter(Boolean);
    if (rendererPids.length > 0 && spawnedServer != null) break;
    await delay(250);
  }
  spawnedServer ??= await readSpawnedServer();

  // The direct child pid is exact. Keep the path-scoped lookup as evidence
  // that the running process still belongs to this packaged app bundle.
  const mainPids = listPidsForPath(APP_BINARY).filter(
    (pid) => pid === String(child.pid),
  );
  console.log("DS3 probe — packaged main process PIDs:", mainPids);

  console.log("DS3 probe — renderer subprocess PIDs:", rendererPids);
  console.log("DS3 probe — spawned Nimbus PID:", spawnedServer?.pid ?? null);

  const checks = {
    main_alive: mainPids.length >= 1,
    renderer_alive: rendererPids.length >= 1,
    spawned_server_recorded: spawnedServer !== null,
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
    if (logChunks.length > 0) {
      console.error("DS3 probe — shell logs:\n", logChunks.join(""));
    }
    exitCode = 1;
  } else {
    console.log(
      "DS3 probe — packaged shell launched, renderer alive, all checks pass",
    );
  }
} finally {
  // SIGTERM enters Electron's before-quit handler, which in turn shuts down
  // an app-spawned Nimbus child. Target only this exact process group.
  if (!childExited && child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    const graceful = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      delay(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (!graceful) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  }
  const serverCleanup = await stopRecordedServer(spawnedServer);
  if (!serverCleanup.stopped) {
    console.error(
      `DS3 probe FAILED — Nimbus PID ${spawnedServer?.pid ?? "unknown"} remained live (${serverCleanup.failures.join("; ") || "signals sent but process stayed live"}); preserving ${scratchRoot} for diagnosis`,
    );
    exitCode = 1;
  } else {
    await rm(scratchRoot, { recursive: true, force: true });
  }
}

process.exit(exitCode);
