// src/preload/index.cts — CommonJS preload.
//
// Electron's sandboxed preload runtime does not support ES modules
// (see Electron docs: "Preload scripts in sandboxed renderers do
// not currently support ES modules"), so this file is CommonJS via
// the `.cts` extension. The main process + shared types remain ESM.
//
// Uses plain `require()` / `module.exports` (verbatimModuleSyntax
// would otherwise force `import = require()` / `export =`, but those
// forms confuse vitest's rolldown-based parser even with the
// `.cts` → `ts.transpileModule` shim in `vitest.config.ts`).
//
// Splits the value (`nimbusShell`) from the wire-up
// (`installNimbusShell`) so the spec can exercise the wire-up with a
// fake bridge instead of trying to intercept a CJS `require`. The
// side-effect autorun below covers the actual Electron runtime, and
// `scripts/ds1-browser-probe.mjs` proves it end-to-end.

import type { ContextBridge } from "electron";
import type { NimbusShell } from "../shared/ipc-types";

const nimbusShell: NimbusShell = Object.freeze({ __version: "ds1" });

function installNimbusShell(bridge: ContextBridge): void {
  bridge.exposeInMainWorld("nimbusShell", nimbusShell);
}

const electronModule = require("electron") as {
  contextBridge?: ContextBridge;
};

if (
  electronModule !== null &&
  typeof electronModule === "object" &&
  typeof electronModule.contextBridge !== "undefined"
) {
  installNimbusShell(electronModule.contextBridge);
}

module.exports = { nimbusShell, installNimbusShell };
