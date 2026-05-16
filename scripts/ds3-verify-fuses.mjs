#!/usr/bin/env node
// DS3 fuse-audit verification probe. Resolves the packed Electron
// binary path on the current host platform (macOS, Linux, Windows)
// inside the `release/` directory produced by `electron-builder
// --dir` and delegates to scripts/prepublish-check.cjs.
//
// Exits 0 on success, 1 on fuse drift, 2 on resolution failure.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const RELEASE_DIRS = {
  darwin: ["mac-arm64", "mac"],
  linux: ["linux-unpacked"],
  win32: ["win-unpacked"],
};

const PRODUCT_FILENAME = "nimbus-desktop";

function macBinaryFor(releaseSubdir) {
  return resolve(
    ROOT,
    "release",
    releaseSubdir,
    `${PRODUCT_FILENAME}.app`,
    "Contents",
    "MacOS",
    PRODUCT_FILENAME,
  );
}

function unixBinaryFor(releaseSubdir) {
  return resolve(ROOT, "release", releaseSubdir, PRODUCT_FILENAME);
}

function winBinaryFor(releaseSubdir) {
  return resolve(ROOT, "release", releaseSubdir, `${PRODUCT_FILENAME}.exe`);
}

function resolveBinary() {
  const subdirs = RELEASE_DIRS[process.platform];
  if (!subdirs) {
    throw new Error(`unsupported platform: ${process.platform}`);
  }
  for (const sub of subdirs) {
    const candidate =
      process.platform === "darwin"
        ? macBinaryFor(sub)
        : process.platform === "win32"
          ? winBinaryFor(sub)
          : unixBinaryFor(sub);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `release binary not found under release/${subdirs.join(", ")}. Did you run \`npm run package\`?`,
  );
}

let binary;
try {
  binary = resolveBinary();
} catch (err) {
  console.error("ds3-verify-fuses: setup error:", err?.message ?? err);
  process.exit(2);
}

console.log("ds3-verify-fuses — auditing fuses on:", binary);
const result = spawnSync(
  process.execPath,
  [resolve(ROOT, "scripts/prepublish-check.cjs"), binary],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
