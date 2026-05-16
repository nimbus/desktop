#!/usr/bin/env node
"use strict";

// DS3 contract: electron-builder afterPack hook. After the packed
// app directory has been laid out (but before code signing), flip
// the Electron Fuses on the bundled Electron binary so the
// production build cannot be coerced into running arbitrary scripts
// (RunAsNode), accepting NODE_OPTIONS, attaching an inspector, or
// loading app code from outside the asar.
//
// References:
//   - https://www.electronjs.org/docs/latest/tutorial/fuses
//   - @electron/fuses 2.1.1
//   - Inspector toggle env var: NIMBUS_DESKTOP_ENABLE_INSPECT=1 to
//     opt in for explicit dev builds. Default (production): inspector
//     OFF.

const path = require("node:path");

const { flipFuses, FuseV1Options, FuseVersion } = require("@electron/fuses");

const INSPECTOR_OPT_IN_ENV = "NIMBUS_DESKTOP_ENABLE_INSPECT";

function resolveBinaryPath(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  const productFilename = packager?.appInfo?.productFilename ?? "nimbus-desktop";
  switch (electronPlatformName) {
    case "darwin":
    case "mas":
      return path.join(
        appOutDir,
        `${productFilename}.app`,
        "Contents",
        "MacOS",
        productFilename,
      );
    case "win32":
      return path.join(appOutDir, `${productFilename}.exe`);
    case "linux":
      return path.join(appOutDir, productFilename);
    default:
      throw new Error(
        `flip-fuses: unsupported electronPlatformName "${electronPlatformName}"`,
      );
  }
}

async function flipAppFuses(context) {
  const binary = resolveBinaryPath(context);
  const enableInspect = process.env[INSPECTOR_OPT_IN_ENV] === "1";

  const fuses = {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: enableInspect,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    resetAdHocDarwinSignature: context.electronPlatformName === "darwin",
  };

  process.stdout.write(
    `[flip-fuses] flipping fuses on ${binary} (inspect=${enableInspect})\n`,
  );
  await flipFuses(binary, fuses);
  process.stdout.write("[flip-fuses] fuses flipped\n");
}

module.exports = flipAppFuses;
module.exports.default = flipAppFuses;
