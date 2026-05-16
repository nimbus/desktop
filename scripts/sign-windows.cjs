#!/usr/bin/env node
"use strict";

// DS8 contract: electron-builder win.signtoolOptions.sign hook.
// Invoked by electron-builder for each Windows artifact that needs
// signing (.exe, embedded .dll/.node). Routes to the Azure Trusted
// Signing CLI per decision 002.
//
// **Deferral status:** decision 002 is "accepted (DS0A); activation
// deferred" — the first release ships macOS + Linux only. While
// deferred, this hook is a documented no-op: it logs that signing
// was skipped and returns 0 so the dry-run Windows packaging lane
// still produces an unsigned NSIS installer for internal smoke
// testing. When 002 flips to "accepted — active" (Trusted Signing
// onboarding complete), the early-return is removed and the
// Trusted Signing CLI invocation below activates.
//
// References:
//   - https://learn.microsoft.com/en-us/azure/trusted-signing/
//   - https://www.electron.build/code-signing#sign-using-signtoolOptions
//   - docs/decisions/002-windows-code-signing.md

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REQUIRED_ENV = [
  "DESKTOP_WINDOWS_TS_TENANT_ID",
  "DESKTOP_WINDOWS_TS_CLIENT_ID",
  "DESKTOP_WINDOWS_TS_CLIENT_SECRET",
  "DESKTOP_WINDOWS_TS_ENDPOINT",
  "DESKTOP_WINDOWS_TS_ACCOUNT_NAME",
  "DESKTOP_WINDOWS_TS_CERT_PROFILE",
];

function log(msg) {
  process.stdout.write(`[sign-windows] ${msg}\n`);
}

exports.default = async function sign(configuration) {
  const target = configuration?.path;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("sign-windows: configuration.path missing");
  }
  if (!fs.existsSync(target)) {
    throw new Error(`sign-windows: artifact not found at ${target}`);
  }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length === REQUIRED_ENV.length) {
    log(
      `no Trusted Signing credentials in env — skipping signing for ${path.basename(target)} (decision 002 deferral)`,
    );
    return;
  }
  if (missing.length > 0) {
    throw new Error(
      `sign-windows: required env vars missing: ${missing.join(", ")}`,
    );
  }

  // Trusted Signing CLI activation point. Resolution of the actual
  // binary path lands when decision 002 flips to active; until then
  // the early-return above prevents this branch from running.
  log(`signing ${path.basename(target)} via Azure Trusted Signing`);
  const result = spawnSync(
    "azuresigntool",
    [
      "sign",
      "-kvu",
      process.env.DESKTOP_WINDOWS_TS_ENDPOINT,
      "-kvi",
      process.env.DESKTOP_WINDOWS_TS_CLIENT_ID,
      "-kvt",
      process.env.DESKTOP_WINDOWS_TS_TENANT_ID,
      "-kvs",
      process.env.DESKTOP_WINDOWS_TS_CLIENT_SECRET,
      "-kvc",
      process.env.DESKTOP_WINDOWS_TS_CERT_PROFILE,
      "-tr",
      "http://timestamp.acs.microsoft.com",
      "-td",
      "sha256",
      target,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(
      `sign-windows: azuresigntool exited with status ${result.status}`,
    );
  }
};
