// src/preload/index.cts — CommonJS preload.
//
// Electron's sandboxed preload runtime does not support ES modules,
// so this file is CommonJS via the `.cts` extension. The main process
// + shared types remain ESM.
//
// Uses plain `require()` / `module.exports`. Splits the value
// (`nimbusShell`) from the wire-up (`installNimbusShell`) so the spec
// can exercise the wire-up with a fake bridge instead of trying to
// intercept a CJS `require`. The side-effect autorun below covers the
// actual Electron runtime, and `scripts/ds4-bounds-probe.mjs` proves it
// end-to-end.

import type { ContextBridge, IpcRenderer } from "electron";
import type { NimbusShell, TrayStatusDot } from "../shared/ipc-types";

const TRAY_CHANNEL = "nimbus:tray:setStatusDot";

function buildShell(ipc: IpcRenderer): NimbusShell {
  return Object.freeze({
    __version: "ds4",
    tray: Object.freeze({
      setStatusDot: (state: TrayStatusDot) => ipc.invoke(TRAY_CHANNEL, state),
    }),
  });
}

function installNimbusShell(
  bridge: ContextBridge,
  ipc: IpcRenderer,
): NimbusShell {
  const shell = buildShell(ipc);
  bridge.exposeInMainWorld("nimbusShell", shell);
  return shell;
}

const electronModule = require("electron") as {
  contextBridge?: ContextBridge;
  ipcRenderer?: IpcRenderer;
};

if (
  electronModule !== null &&
  typeof electronModule === "object" &&
  typeof electronModule.contextBridge !== "undefined" &&
  typeof electronModule.ipcRenderer !== "undefined"
) {
  installNimbusShell(electronModule.contextBridge, electronModule.ipcRenderer);
}

module.exports = { buildShell, installNimbusShell };
