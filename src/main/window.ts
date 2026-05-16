import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow } from "electron";

import { applyToWebContents } from "./security.js";

export interface MainWindowOptions {
  readonly url: string;
  readonly preloadPath: string;
}

export interface WebPreferencesBaseline {
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly webSecurity: true;
  readonly preload: string;
}

export function buildWebPreferences(
  preloadPath: string,
): WebPreferencesBaseline {
  return {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    preload: preloadPath,
  };
}

export function defaultPreloadPath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // Preload is emitted as `.cjs` because Electron's sandboxed
  // preload runtime does not support ES modules (see Electron docs:
  // "Preload scripts in sandboxed renderers do not currently support
  // ES modules"). Source lives at `src/preload/index.cts`.
  return path.join(here, "..", "preload", "index.cjs");
}

export function createMainWindow(
  opts: MainWindowOptions,
): InstanceType<typeof BrowserWindow> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    webPreferences: buildWebPreferences(opts.preloadPath),
  });
  applyToWebContents(win.webContents, { allowedOrigin: opts.url });
  win.once("ready-to-show", () => win.show());
  void win.loadURL(opts.url);
  return win;
}
