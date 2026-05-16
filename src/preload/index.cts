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
// actual Electron runtime, and the DS5 mocked-feed probe proves the
// updater bridge end-to-end.

import type { ContextBridge, IpcRenderer } from "electron";
import type {
  NimbusShell,
  TrayStatusDot,
  UpdaterStateChange,
  UpdaterStateListener,
} from "../shared/ipc-types";

const TRAY_CHANNEL = "nimbus:tray:setStatusDot";
const UPDATER_STATE_CHANGED_CHANNEL = "nimbus:updater:state-changed";
const UPDATER_CHECK_FOR_UPDATES_CHANNEL = "nimbus:updater:checkForUpdates";

function buildShell(ipc: IpcRenderer): NimbusShell {
  return Object.freeze({
    __version: "ds5",
    tray: Object.freeze({
      setStatusDot: (state: TrayStatusDot) => ipc.invoke(TRAY_CHANNEL, state),
    }),
    updater: Object.freeze({
      onStateChange: (listener: UpdaterStateListener) => {
        const wrapped = (_event: unknown, change: UpdaterStateChange) => {
          listener(change);
        };
        ipc.on(UPDATER_STATE_CHANGED_CHANNEL, wrapped);
        return () => {
          ipc.removeListener(UPDATER_STATE_CHANGED_CHANNEL, wrapped);
        };
      },
      checkForUpdates: () =>
        ipc.invoke(UPDATER_CHECK_FOR_UPDATES_CHANNEL) as Promise<void>,
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
