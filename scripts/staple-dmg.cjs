#!/usr/bin/env node
"use strict";

// DS8 contract follow-on: electron-builder's `afterAllArtifactBuild`
// hook. By this point electron-builder has produced and signed the
// .app, scripts/notarize.cjs (afterSign) has notarized + stapled the
// .app, and the DMG/ZIP packagers have wrapped the notarized .app
// into their containers. The .app inside the containers is already
// stapled, but the DMG itself is not — `xcrun stapler validate` on
// the DMG file (which Gatekeeper does for offline first-launch
// scenarios where the network is unavailable) requires the DMG to
// carry its own ticket.
//
// We submit each release/*.dmg to notarytool and staple it. The hook
// fires BEFORE electron-builder writes `latest-mac.yml`, so the
// post-staple file hash flows into the auto-update manifest cleanly.
//
// ZIPs do not need stapling — Gatekeeper extracts the .app and
// verifies the ticket on the .app itself, which is already stapled
// by scripts/notarize.cjs. Submitting the ZIP for notarization would
// be redundant.
//
// Dry-run / package-only matrix: when API-key env vars are absent
// the hook is a no-op (matches scripts/notarize.cjs).

const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REQUIRED_ENV = [
  "DESKTOP_APPLE_API_KEY_PATH",
  "DESKTOP_APPLE_API_KEY_ID",
  "DESKTOP_APPLE_API_ISSUER",
];

function log(msg) {
  process.stdout.write(`[staple-dmg] ${msg}\n`);
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
}

module.exports = async function stapleDmgs(context) {
  if (process.platform !== "darwin") {
    return;
  }

  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length === REQUIRED_ENV.length) {
    log("no Apple API credentials in env — skipping DMG notarize+staple");
    return;
  }
  if (missing.length > 0) {
    throw new Error(
      `staple-dmg: required env vars missing: ${missing.join(", ")}`,
    );
  }

  const artifactPaths = Array.isArray(context.artifactPaths)
    ? context.artifactPaths
    : [];
  const dmgs = artifactPaths.filter((p) => p.toLowerCase().endsWith(".dmg"));
  if (dmgs.length === 0) {
    log("no DMG artifacts in afterAllArtifactBuild context; nothing to staple");
    return;
  }

  const keyPath = process.env.DESKTOP_APPLE_API_KEY_PATH;
  const keyId = process.env.DESKTOP_APPLE_API_KEY_ID;
  const issuer = process.env.DESKTOP_APPLE_API_ISSUER;

  for (const dmg of dmgs) {
    const name = path.basename(dmg);
    log(`submitting ${name} to notarytool (this can take 1-10 min)`);
    const start = Date.now();
    run("xcrun", [
      "notarytool",
      "submit",
      dmg,
      "--key",
      keyPath,
      "--key-id",
      keyId,
      "--issuer",
      issuer,
      "--wait",
    ]);
    log(`stapling ticket onto ${name}`);
    run("xcrun", ["stapler", "staple", dmg]);
    run("xcrun", ["stapler", "validate", dmg]);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log(`${name} notarized + stapled in ${elapsed}s`);
  }
};
