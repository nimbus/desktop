#!/usr/bin/env node
"use strict";

// DS6 contract: post-package installer size audit.
//
// Per-artifact budgets:
//   - per-arch installer (.dmg/.exe/.AppImage/.deb/.rpm) < 200 MiB
//   - per-arch zip distribution archive            < 200 MiB
//   - macOS universal installer (carries arm64 + x64 Electron) < 250 MiB
//   - unpacked app.asar                                         <  80 MiB
//
// The universal-mac headroom is wider because the DMG carries both
// arm64 and x64 Electron payloads (~100 MiB compressed Electron alone)
// merged via @electron/universal. Linux/Windows installers stay on
// the per-arch budget because the plan ships per-arch NSIS / AppImage
// / deb / rpm artifacts.
//
// Usage:
//   node scripts/check-installer-sizes.cjs <release-dir>
//
// Exit codes:
//   0 — every observed installer meets its budget
//   1 — at least one installer exceeded its budget (table to stderr)
//   2 — setup error (release dir missing, no installers found)

const path = require("node:path");
const fs = require("node:fs");

const INSTALLER_BUDGET_BYTES = 200 * 1024 * 1024;
const UNIVERSAL_INSTALLER_BUDGET_BYTES = 250 * 1024 * 1024;
const ASAR_BUDGET_BYTES = 80 * 1024 * 1024;

const INSTALLER_EXTENSIONS = new Set([
  ".dmg",
  ".zip",
  ".exe",
  ".AppImage",
  ".deb",
  ".rpm",
]);

function installerBudget(name) {
  return /-universal/.test(name)
    ? UNIVERSAL_INSTALLER_BUDGET_BYTES
    : INSTALLER_BUDGET_BYTES;
}

function* walkInstallers(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // electron-builder emits intermediate per-arch dirs (mac-arm64/,
      // mac/, win-unpacked/, linux-unpacked/) plus their `.app` /
      // resources subtrees. We only audit terminal installer files at
      // the top level — recursing would pick up asar internals which
      // are handled separately by walkAsar.
      continue;
    }
    const ext = path.extname(entry.name);
    if (INSTALLER_EXTENSIONS.has(ext)) {
      yield full;
    }
  }
}

function* walkAsar(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkAsar(full);
    } else if (entry.name === "app.asar") {
      yield full;
    }
  }
}

function humanBytes(n) {
  const units = ["B", "KiB", "MiB", "GiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

function main() {
  const releaseDir = path.resolve(process.argv[2] ?? "release");
  if (!fs.existsSync(releaseDir)) {
    process.stderr.write(
      `check-installer-sizes: release dir not found: ${releaseDir}\n`,
    );
    process.exit(2);
  }

  const installers = [...walkInstallers(releaseDir)];
  const asars = [...walkAsar(releaseDir)];

  if (installers.length === 0 && asars.length === 0) {
    process.stderr.write(
      `check-installer-sizes: no installers or asars found under ${releaseDir}\n`,
    );
    process.exit(2);
  }

  const drift = [];
  for (const installer of installers) {
    const size = fs.statSync(installer).size;
    const budget = installerBudget(path.basename(installer));
    if (size > budget) {
      drift.push({
        kind: "installer",
        path: installer,
        size,
        budget,
      });
    }
  }
  for (const asar of asars) {
    const size = fs.statSync(asar).size;
    if (size > ASAR_BUDGET_BYTES) {
      drift.push({
        kind: "asar",
        path: asar,
        size,
        budget: ASAR_BUDGET_BYTES,
      });
    }
  }

  if (drift.length > 0) {
    process.stderr.write("check-installer-sizes FAILED — size drift:\n");
    for (const row of drift) {
      process.stderr.write(
        `  [${row.kind}] ${row.path}\n` +
          `    size=${humanBytes(row.size)} budget=${humanBytes(row.budget)}\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(
    `check-installer-sizes OK — ${installers.length} installer(s) + ${asars.length} asar(s) under budget\n`,
  );
  for (const installer of installers) {
    const size = fs.statSync(installer).size;
    const budget = installerBudget(path.basename(installer));
    process.stdout.write(
      `  [installer] ${path.basename(installer)}: ${humanBytes(size)} (budget ${humanBytes(budget)})\n`,
    );
  }
  for (const asar of asars) {
    const size = fs.statSync(asar).size;
    process.stdout.write(
      `  [asar] ${path.relative(releaseDir, asar)}: ${humanBytes(size)} (budget ${humanBytes(ASAR_BUDGET_BYTES)})\n`,
    );
  }
}

main();
