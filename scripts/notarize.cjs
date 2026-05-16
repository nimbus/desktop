#!/usr/bin/env node
"use strict";

// DS8 contract: electron-builder afterSign hook. After electron-builder
// has produced and Developer-ID-signed the packed .app on macOS, ship
// the .app to Apple's notarytool service and block until notarization
// completes (or fails). Stapling the ticket onto the DMG itself is
// handled by scripts/staple-dmg.cjs from the afterAllArtifactBuild
// hook — electron-builder 26.x does not staple DMGs automatically,
// proven on tag v0.0.0-dryrun-6 where `stapler validate` on the DMG
// failed even after the .app inside it carried a valid ticket.
//
// Authentication path: App Store Connect API key (decision 001). The
// release workflow:
//   1. Base64-decodes the DESKTOP_APPLE_API_KEY secret into a temp
//      .p8 file and exports DESKTOP_APPLE_API_KEY_PATH to its path.
//   2. Imports the DESKTOP_APPLE_CERT_P12 into the runner keychain so
//      electron-builder's own signing step succeeds.
//   3. Runs `electron-builder --mac --publish=never`, which invokes
//      this hook for the macOS .app after signing.
//
// Dry-run / package-only matrix behavior: when API-key env vars are
// absent, the hook is a no-op (returns 0 without contacting Apple).
// That matches the DS6 e2e.yml CI lane which packages without
// credentials to prove the wiring.
//
// References:
//   - https://github.com/electron/notarize
//   - docs/decisions/001-apple-signing-and-notarization.md

const path = require("node:path");
const fs = require("node:fs");

const { notarize } = require("@electron/notarize");

// notarytool with an App Store Connect API key derives the team from the
// key itself, so DESKTOP_APPLE_TEAM_ID is informational only here. We do
// NOT pass `teamId` into @electron/notarize when also passing API-key
// fields — its validator (validate-args.ts) classifies `teamId` as a
// PASSWORD credential and rejects the call with
//   "Cannot use password credentials, API key credentials and keychain
//    credentials at once"
// The team id stays in REQUIRED_ENV so the release workflow continues to
// surface a meaningful error when the secret is missing.
const REQUIRED_ENV = [
  "DESKTOP_APPLE_API_KEY_PATH",
  "DESKTOP_APPLE_API_KEY_ID",
  "DESKTOP_APPLE_API_ISSUER",
  "DESKTOP_APPLE_TEAM_ID",
];

function log(msg) {
  process.stdout.write(`[notarize] ${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[notarize] ${msg}\n`);
}

function resolveAppPath(context) {
  const { appOutDir, packager } = context;
  const productFilename = packager?.appInfo?.productFilename;
  if (!productFilename) {
    throw new Error(
      "notarize: packager.appInfo.productFilename missing; cannot resolve .app path",
    );
  }
  return path.join(appOutDir, `${productFilename}.app`);
}

module.exports = async function notarizing(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length === REQUIRED_ENV.length) {
    // Dry-run / package-only matrix: no credentials supplied. Skip
    // without failing so the unsigned-package smoke lane still passes.
    log(
      "no Apple API credentials in env — skipping notarization (dry-run mode)",
    );
    return;
  }
  if (missing.length > 0) {
    throw new Error(
      `notarize: required env vars missing: ${missing.join(", ")}`,
    );
  }

  const appPath = resolveAppPath(context);
  if (!fs.existsSync(appPath)) {
    throw new Error(`notarize: .app not found at ${appPath}`);
  }
  const keyPath = process.env.DESKTOP_APPLE_API_KEY_PATH;
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `notarize: API key file does not exist at DESKTOP_APPLE_API_KEY_PATH=${keyPath}`,
    );
  }

  log(`submitting ${appPath} to Apple notarytool (this can take 5-30 min)`);
  const start = Date.now();
  await notarize({
    tool: "notarytool",
    appPath,
    appleApiKey: keyPath,
    appleApiKeyId: process.env.DESKTOP_APPLE_API_KEY_ID,
    appleApiIssuer: process.env.DESKTOP_APPLE_API_ISSUER,
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log(`notarization accepted in ${elapsed}s; ticket stapled to ${appPath}`);
};
