#!/usr/bin/env node
"use strict";

// DS3 contract: post-package fuse audit. Parses the Electron Fuses
// on the packed binary using @electron/fuses' read API and hard-fails
// if any required fuse drifts from the production posture. Called
// after `npm run package*` and gated in DS9 release CI before tagging.
//
// Usage:
//   node scripts/prepublish-check.cjs <path-to-electron-binary>
//
// Exit codes:
//   0 — all required fuses match
//   1 — at least one fuse drifted (table printed to stderr)
//   2 — setup error (binary not found, fuse parsing failure, etc.)

const path = require("node:path");
const fs = require("node:fs");

const {
  FuseState,
  FuseV1Options,
  getCurrentFuseWire,
} = require("@electron/fuses");

const INSPECTOR_OPT_IN_ENV = "NIMBUS_DESKTOP_ENABLE_INSPECT";

// `getCurrentFuseWire` returns a record keyed by FuseV1Options whose
// values are FuseState enum members (`DISABLE=48`, `ENABLE=49`,
// `REMOVED=114`, `INHERIT=144` — the underlying ASCII chars '0', '1'
// in the binary fuse strip). Compare against the enum, not a plain
// boolean.
const REQUIRED_FUSES = [
  {
    option: FuseV1Options.RunAsNode,
    expected: FuseState.DISABLE,
    label: "RunAsNode",
  },
  {
    option: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
    expected: FuseState.DISABLE,
    label: "EnableNodeOptionsEnvironmentVariable",
  },
  {
    option: FuseV1Options.EnableNodeCliInspectArguments,
    // Allow opt-in via env var so the same script verifies both
    // production (DISABLE) and explicit inspect-enabled dev builds.
    expected:
      process.env[INSPECTOR_OPT_IN_ENV] === "1"
        ? FuseState.ENABLE
        : FuseState.DISABLE,
    label: "EnableNodeCliInspectArguments",
  },
  {
    option: FuseV1Options.EnableCookieEncryption,
    expected: FuseState.ENABLE,
    label: "EnableCookieEncryption",
  },
  {
    option: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
    expected: FuseState.ENABLE,
    label: "EnableEmbeddedAsarIntegrityValidation",
  },
  {
    option: FuseV1Options.OnlyLoadAppFromAsar,
    expected: FuseState.ENABLE,
    label: "OnlyLoadAppFromAsar",
  },
];

function fuseLabel(state) {
  return FuseState[state] ?? String(state);
}

async function main() {
  const binary = process.argv[2];
  if (!binary) {
    process.stderr.write(
      "usage: node scripts/prepublish-check.cjs <electron-binary>\n",
    );
    process.exit(2);
  }
  const resolved = path.resolve(binary);
  if (!fs.existsSync(resolved)) {
    process.stderr.write(`prepublish-check: binary not found: ${resolved}\n`);
    process.exit(2);
  }

  let wire;
  try {
    wire = await getCurrentFuseWire(resolved);
  } catch (err) {
    process.stderr.write(
      `prepublish-check: failed to read fuses from ${resolved}: ${err?.stack ?? err}\n`,
    );
    process.exit(2);
  }

  const drift = [];
  for (const { option, expected, label } of REQUIRED_FUSES) {
    const observed = wire[option];
    if (observed !== expected) {
      drift.push({ label, expected, observed });
    }
  }

  if (drift.length > 0) {
    process.stderr.write("prepublish-check FAILED — fuse drift:\n");
    for (const row of drift) {
      process.stderr.write(
        `  ${row.label}: expected=${fuseLabel(row.expected)} observed=${fuseLabel(row.observed)}\n`,
      );
    }
    process.exit(1);
  }

  process.stdout.write(
    `prepublish-check OK — ${REQUIRED_FUSES.length} fuses verified on ${resolved}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`prepublish-check: unexpected error: ${err?.stack ?? err}\n`);
  process.exit(2);
});
