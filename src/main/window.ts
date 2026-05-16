import path from "node:path";
import { fileURLToPath } from "node:url";

import { BrowserWindow } from "electron";

import { applyToWebContents } from "./security.js";
import type { WindowBounds } from "./window-state.js";

export interface MainWindowOptions {
  readonly url: string;
  readonly preloadPath: string;
  readonly bounds?: WindowBounds | null;
  readonly onBoundsChanged?: (bounds: WindowBounds) => void;
}

export interface WebPreferencesBaseline {
  readonly sandbox: true;
  readonly contextIsolation: true;
  readonly nodeIntegration: false;
  readonly webSecurity: true;
  readonly preload: string;
}

export const DEFAULT_WINDOW_WIDTH = 1280;
export const DEFAULT_WINDOW_HEIGHT = 800;
export const MIN_WINDOW_WIDTH = 960;
export const MIN_WINDOW_HEIGHT = 600;

const BOUNDS_DEBOUNCE_MS = 250;

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
  // Preload is emitted as `.cjs` because Electron's sandboxed preload
  // runtime does not support ES modules. Source lives at
  // `src/preload/index.cts`.
  return path.join(here, "..", "preload", "index.cjs");
}

export function createMainWindow(
  opts: MainWindowOptions,
): InstanceType<typeof BrowserWindow> {
  const win = new BrowserWindow({
    width: opts.bounds?.width ?? DEFAULT_WINDOW_WIDTH,
    height: opts.bounds?.height ?? DEFAULT_WINDOW_HEIGHT,
    x: opts.bounds?.x,
    y: opts.bounds?.y,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    webPreferences: buildWebPreferences(opts.preloadPath),
  });
  applyToWebContents(win.webContents, { allowedOrigin: opts.url });
  win.once("ready-to-show", () => win.show());

  if (opts.onBoundsChanged) {
    const persist = debounce(() => {
      const bounds = win.getBounds();
      opts.onBoundsChanged?.({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      });
    }, BOUNDS_DEBOUNCE_MS);
    win.on("resize", persist);
    win.on("move", persist);
    win.on("close", persist);
  }

  void win.loadURL(opts.url);
  return win;
}

function debounce(fn: () => void, ms: number): () => void {
  let handle: NodeJS.Timeout | null = null;
  return () => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      fn();
    }, ms);
  };
}
