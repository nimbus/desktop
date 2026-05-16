import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, type BrowserWindow, dialog, ipcMain, Menu } from "electron";
import {
  TRAY_SET_STATUS_DOT_CHANNEL,
  UPDATER_CHECK_FOR_UPDATES_CHANNEL,
  UPDATER_STATE_CHANGED_CHANNEL,
  type UpdaterStateChange,
} from "../shared/ipc-types.js";
import { createIpcRouter, type IpcRouter } from "./ipc.js";
import { buildAppMenu, type MenuPlatform } from "./menu.js";
import { installSecurityRestrictions } from "./security.js";
import {
  NimbusBinaryNotFoundError,
  resolveServer,
  type ServerEnvelope,
  ServerNotRunningError,
  ServerReadinessTimeoutError,
  type SpawnedServerHandle,
} from "./server.js";
import {
  createTrayController,
  isTrayStatus,
  type TrayController,
  type TrayStatus,
} from "./tray.js";
import {
  createUpdaterController,
  type ElectronUpdaterLike,
  type UpdaterController,
} from "./updater.js";
import { createMainWindow, defaultPreloadPath } from "./window.js";
import { loadWindowState, saveWindowState } from "./window-state.js";

const ALLOWED_ORIGIN_FALLBACK = "http://127.0.0.1/";
const SHUTDOWN_GRACE_MS = 5_000;
const QUIT_WAIT_FOR_SPAWN_MS = 3_000;

export async function main(): Promise<void> {
  // The harness's SIGTERM (mapped by Electron to before-quit) can land
  // mid-readiness-wait — AFTER we've spawned nimbus but BEFORE
  // resolveServer has returned. Register a single before-quit handler
  // up front, against module-scoped state that the resolveServer
  // onSpawn callback populates the moment the child exists, so the
  // first quit (whenever it arrives) reaps the child cleanly. Without
  // this seam, a SIGTERM mid-setup leaves the spawned nimbus as an
  // orphan because the late-registered handler never sees it.
  let nimbusHandle: SpawnedServerHandle | null = null;
  let nimbusUrl: string | null = null;
  let shuttingDown = false;
  let resolveSpawned: ((handle: SpawnedServerHandle) => void) | null = null;
  const spawnedPromise = new Promise<SpawnedServerHandle>((resolve) => {
    resolveSpawned = resolve;
  });

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    void (async () => {
      const handle =
        nimbusHandle ??
        (await Promise.race([
          spawnedPromise,
          new Promise<null>((r) =>
            setTimeout(() => r(null), QUIT_WAIT_FOR_SPAWN_MS),
          ),
        ]));
      const url = nimbusUrl;
      if (handle && url) {
        try {
          await shutdownSpawnedServer(url, handle.pid, handle.child);
        } catch {
          // best-effort; we are exiting anyway
        }
      } else if (handle) {
        // No URL yet (SIGTERM arrived before resolveServer returned).
        // Signal the spawned nimbus directly so it doesn't outlive us.
        try {
          handle.child.kill("SIGTERM");
        } catch {}
      }
      app.exit(0);
    })();
  });

  await app.whenReady();

  let envelope: ServerEnvelope;
  try {
    envelope = await resolveServer({
      ensure: true,
      onSpawn: (handle) => {
        nimbusHandle = handle;
        resolveSpawned?.(handle);
      },
    });
  } catch (error) {
    presentFatalError(error);
    app.quit();
    return;
  }
  nimbusUrl = envelope.url;

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

  await initializeUpdater(win, allowedOrigin);

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
  // DS5+ may grow this to a real restart-loop; the tray menu still
  // surfaces the action so the seam is present.
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

async function initializeUpdater(
  win: BrowserWindow,
  allowedOrigin: string,
): Promise<UpdaterController | null> {
  const autoUpdater = await resolveAutoUpdater();
  if (autoUpdater === null) {
    return null;
  }
  const controller = createUpdaterController({
    autoUpdater,
    onStateChange: (change: UpdaterStateChange) => {
      if (win.isDestroyed()) return;
      win.webContents.send(UPDATER_STATE_CHANGED_CHANNEL, change);
    },
  });
  const router = createIpcRouter({ allowedOrigin, ipc: ipcMain });
  router.register<void, void>(UPDATER_CHECK_FOR_UPDATES_CHANNEL, async () => {
    await controller.checkForUpdates();
  });
  return controller;
}

async function resolveAutoUpdater(): Promise<ElectronUpdaterLike | null> {
  if (process.env.NIMBUS_DESKTOP_UPDATER_MOCK === "1") {
    const mock = createMockAutoUpdater();
    (
      globalThis as { __nimbusTestAutoUpdater?: MockAutoUpdater }
    ).__nimbusTestAutoUpdater = mock;
    return mock;
  }
  // In non-packaged dev builds electron-updater refuses to run; skip
  // wiring entirely so the renderer never sees stale events from a
  // partial init. The DS5 verification path drives a mocked feed; the
  // signed-release end-to-end proof rides on DS8 + DS9.
  if (!app.isPackaged && process.env.NIMBUS_DESKTOP_UPDATER_FORCE !== "1") {
    return null;
  }
  try {
    // electron-updater ships CJS. Under Node ESM interop the named
    // re-export sometimes lands on `mod.autoUpdater` and sometimes
    // under `mod.default.autoUpdater` (the latter is what we see
    // when loaded out of an asar in a packaged build). Accept both
    // shapes; treat an unresolved `autoUpdater` as a hard skip so
    // the renderer never sees a partially-initialized updater.
    const mod = (await import("electron-updater")) as unknown as {
      autoUpdater?: ElectronUpdaterLike;
      default?: { autoUpdater?: ElectronUpdaterLike };
    };
    return mod.autoUpdater ?? mod.default?.autoUpdater ?? null;
  } catch {
    return null;
  }
}

interface MockAutoUpdater extends ElectronUpdaterLike {
  emit(event: string, ...args: unknown[]): void;
}

function createMockAutoUpdater(): MockAutoUpdater {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const bucket = (event: string) => {
    let b = listeners.get(event);
    if (!b) {
      b = new Set();
      listeners.set(event, b);
    }
    return b;
  };
  return {
    autoDownload: undefined,
    autoInstallOnAppQuit: undefined,
    on(event: string, fn: (...args: unknown[]) => void) {
      bucket(event).add(fn);
      return this;
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      bucket(event).delete(fn);
      return this;
    },
    async checkForUpdates() {
      return null;
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of bucket(event)) {
        fn(...args);
      }
    },
  };
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
    // server may already be gone or unresponsive; fall through to signal path
  }
  try {
    child.kill("SIGTERM");
  } catch {}
  await sleep(250);
  try {
    process.kill(pid, 0);
    child.kill("SIGKILL");
  } catch {
    // pid is already gone — what we wanted
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
