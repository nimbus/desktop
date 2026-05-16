import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, type BrowserWindow, dialog, ipcMain, Menu } from "electron";
import { TRAY_SET_STATUS_DOT_CHANNEL } from "../shared/ipc-types.js";
import { createIpcRouter, type IpcRouter } from "./ipc.js";
import { buildAppMenu, type MenuPlatform } from "./menu.js";
import { installSecurityRestrictions } from "./security.js";
import {
  NimbusBinaryNotFoundError,
  resolveServer,
  type ServerEnvelope,
  ServerNotRunningError,
  ServerReadinessTimeoutError,
} from "./server.js";
import {
  createTrayController,
  isTrayStatus,
  type TrayController,
  type TrayStatus,
} from "./tray.js";
import { createMainWindow, defaultPreloadPath } from "./window.js";
import { loadWindowState, saveWindowState } from "./window-state.js";

const ALLOWED_ORIGIN_FALLBACK = "http://127.0.0.1/";
const SHUTDOWN_GRACE_MS = 5_000;

export async function main(): Promise<void> {
  await app.whenReady();

  let envelope: ServerEnvelope;
  try {
    envelope = await resolveServer({ ensure: true });
  } catch (error) {
    presentFatalError(error);
    app.quit();
    return;
  }

  const allowedOrigin = originOf(envelope.url, ALLOWED_ORIGIN_FALLBACK);
  installSecurityRestrictions(app, { allowedOrigin });

  const userDataDir = app.getPath("userData");
  const initialBounds = await loadWindowState(userDataDir);

  const win = createMainWindow({
    url: envelope.url,
    preloadPath: defaultPreloadPath(),
    bounds: initialBounds,
    onBoundsChanged: (bounds) => {
      void saveWindowState(userDataDir, bounds);
    },
  });

  const platform = process.platform as MenuPlatform;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppMenu(platform, {
        onOpenConsole: () => openConsole(win),
        onAbout: () =>
          dialog.showMessageBox(win, {
            type: "info",
            title: "About Nimbus",
            message: "Nimbus Desktop",
            detail: `Server: ${envelope.url}\nOrigin: ${envelope.origin}`,
          }),
        onQuit: () => app.quit(),
      }),
    ),
  );

  const tray = createTrayController({
    iconPath: resolveTrayIconPath(),
    handlers: {
      onOpenConsole: () => openConsole(win),
      onStartServer: () => onStartServer(),
      onStopServer: () => onStopServer(envelope),
      onRestartServer: () => onRestartServer(envelope, win),
      onQuit: () => app.quit(),
    },
    initialStatus: "connected",
  });

  registerTrayIpc(allowedOrigin, tray);

  if (envelope.spawned) {
    const handle = envelope.spawned;
    const serverUrl = envelope.url;
    app.on("before-quit", (event) => {
      event.preventDefault();
      void shutdownSpawnedServer(serverUrl, handle.pid, handle.child).finally(
        () => app.exit(0),
      );
    });
  }

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("activate", () => {
    openConsole(win);
  });
}

function openConsole(win: ReturnType<typeof createMainWindow>): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function onStartServer(): Promise<void> {
  // DS5 grows this into a real restart-loop with envelope tracking.
  // For DS4, Start is a no-op when the shell already has a live server
  // envelope; the tray menu still shows the action so the seam is
  // present, but a status-text refresh would conflict with the renderer
  // pushing tray:setStatusDot.
  return Promise.resolve();
}

async function onStopServer(envelope: ServerEnvelope): Promise<void> {
  if (envelope.spawned) {
    await shutdownSpawnedServer(
      envelope.url,
      envelope.spawned.pid,
      envelope.spawned.child,
    );
  }
}

async function onRestartServer(
  envelope: ServerEnvelope,
  win: BrowserWindow,
): Promise<void> {
  if (!envelope.spawned) return;
  await shutdownSpawnedServer(
    envelope.url,
    envelope.spawned.pid,
    envelope.spawned.child,
  );
  const next = await resolveServer({ ensure: true });
  await win.loadURL(next.url);
}

function registerTrayIpc(
  allowedOrigin: string,
  tray: TrayController,
): IpcRouter {
  const router = createIpcRouter({ allowedOrigin, ipc: ipcMain });
  router.register<TrayStatus, void>(
    TRAY_SET_STATUS_DOT_CHANNEL,
    (_event, payload) => {
      if (!isTrayStatus(payload)) {
        throw new Error(
          `tray:setStatusDot rejected unknown status: ${String(payload)}`,
        );
      }
      tray.setStatus(payload);
    },
  );
  return router;
}

function resolveTrayIconPath(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  // dist/main/index.js → ../../buildResources/trayTemplate.png
  // In the packaged app the buildResources directory is bundled under
  // the asar root next to dist/.
  return path.join(here, "..", "..", "buildResources", "trayTemplate.png");
}

function originOf(serverUrl: string, fallback: string): string {
  try {
    const parsed = new URL(serverUrl);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return fallback;
  }
}

function presentFatalError(error: unknown): void {
  const message =
    error instanceof ServerNotRunningError ||
    error instanceof ServerReadinessTimeoutError ||
    error instanceof NimbusBinaryNotFoundError
      ? error.message
      : `Unexpected error: ${String(error)}`;
  dialog.showErrorBox?.("Nimbus could not start", message);
}

async function shutdownSpawnedServer(
  serverUrl: string,
  pid: number,
  child: { kill: (signal?: NodeJS.Signals | number) => boolean },
): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SHUTDOWN_GRACE_MS);
    try {
      await fetch(`${serverUrl}api/system/shutdown`, {
        method: "POST",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Fall through to SIGTERM. The server may already be down, or
    // the shutdown endpoint may be unreachable.
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // best-effort: pid may already be gone
  }
  await sleep(250);
  try {
    process.kill(pid, 0);
    child.kill("SIGKILL");
  } catch {
    // process is gone — exactly what we wanted
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isUnderTest =
  process.env.VITEST !== undefined ||
  process.env.NIMBUS_DESKTOP_SKIP_AUTORUN === "1";

if (!isUnderTest) {
  void main();
}
