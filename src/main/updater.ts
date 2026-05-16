// DS5 auto-update controller.
//
// Wires `electron-updater`'s `autoUpdater` event surface into a
// deterministic `UpdaterStateChange` stream that the main process
// forwards to the renderer over the `nimbus:updater:state-changed`
// channel.
//
// Key contracts (asserted by tests):
//   - `autoDownload = true` so update detection automatically
//     proceeds to download in the background
//   - `autoInstallOnAppQuit = true` so a downloaded update lands on
//     the next operator-initiated quit, never a forced restart
//   - `disableSignatureVerification` is NEVER set — `electron-updater`
//     validates code-signing on the downloaded artifact and we rely
//     on that signal as the bedrock of the update trust chain
//
// The `autoUpdater` reference is injected so the spec can drive the
// full state machine against a fake without instantiating the real
// `electron-updater` singleton (which would attempt network I/O and
// crash outside a packaged Electron context).

import type { UpdaterStateChange } from "../shared/ipc-types.js";

export type UpdaterStateListener = (change: UpdaterStateChange) => void;

export interface UpdaterLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

export interface ElectronUpdaterLike {
  autoDownload?: boolean;
  autoInstallOnAppQuit?: boolean;
  logger?: unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener?(
    event: string,
    listener: (...args: unknown[]) => void,
  ): unknown;
  checkForUpdates(): Promise<unknown>;
  checkForUpdatesAndNotify?(): Promise<unknown>;
  quitAndInstall?(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterControllerOptions {
  autoUpdater: ElectronUpdaterLike;
  onStateChange: UpdaterStateListener;
  logger?: UpdaterLogger;
}

export interface UpdaterController {
  checkForUpdates(): Promise<void>;
  getState(): UpdaterStateChange;
  destroy(): void;
}

interface UpdateInfoLike {
  version?: string;
  releaseNotes?: string | unknown;
}

interface DownloadProgressLike {
  bytesPerSecond?: number;
  percent?: number;
  transferred?: number;
  total?: number;
}

const UPDATER_EVENTS = [
  "checking-for-update",
  "update-available",
  "update-not-available",
  "download-progress",
  "update-downloaded",
  "error",
] as const;

type UpdaterEvent = (typeof UPDATER_EVENTS)[number];

export function createUpdaterController(
  options: UpdaterControllerOptions,
): UpdaterController {
  const { autoUpdater, onStateChange, logger } = options;

  // Required posture. Do not weaken these.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Guard against a regression that turns off signature verification.
  // We do this by reading the descriptor and refusing to start if a
  // prior caller set the field. The controller itself never assigns
  // to `disableSignatureVerification` — searching the source for that
  // identifier should return zero hits.
  assertSignatureVerificationEnabled(autoUpdater);

  let lastChange: UpdaterStateChange = { state: "idle" };

  const emit = (change: UpdaterStateChange) => {
    lastChange = change;
    try {
      onStateChange(change);
    } catch (err) {
      logger?.error?.("updater onStateChange listener threw", err);
    }
  };

  const listeners = new Map<UpdaterEvent, (...args: unknown[]) => void>();

  const subscribe = (
    event: UpdaterEvent,
    handler: (...args: unknown[]) => void,
  ) => {
    autoUpdater.on(event, handler);
    listeners.set(event, handler);
  };

  subscribe("checking-for-update", () => {
    emit({ state: "checking" });
  });

  subscribe("update-available", (info) => {
    const u = info as UpdateInfoLike | undefined;
    emit({
      state: "available",
      version: u?.version,
      releaseNotes:
        typeof u?.releaseNotes === "string" ? u.releaseNotes : undefined,
    });
  });

  subscribe("update-not-available", (info) => {
    const u = info as UpdateInfoLike | undefined;
    emit({
      state: "not-available",
      version: u?.version,
    });
  });

  subscribe("download-progress", (raw) => {
    const p = (raw ?? {}) as DownloadProgressLike;
    emit({
      state: "downloading",
      progress: {
        bytesPerSecond: numberOrZero(p.bytesPerSecond),
        percent: numberOrZero(p.percent),
        transferred: numberOrZero(p.transferred),
        total: numberOrZero(p.total),
      },
    });
  });

  subscribe("update-downloaded", (info) => {
    const u = info as UpdateInfoLike | undefined;
    emit({
      state: "downloaded",
      version: u?.version,
      releaseNotes:
        typeof u?.releaseNotes === "string" ? u.releaseNotes : undefined,
    });
  });

  subscribe("error", (err) => {
    emit({
      state: "error",
      message: errorMessage(err),
    });
  });

  const controller: UpdaterController = {
    async checkForUpdates(): Promise<void> {
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        // electron-updater also raises `error` events for these, but
        // we surface here too for synchronous failures during the
        // initial dispatch (e.g. malformed feed URL).
        emit({ state: "error", message: errorMessage(err) });
      }
    },
    getState(): UpdaterStateChange {
      return lastChange;
    },
    destroy(): void {
      const remove = (
        event: UpdaterEvent,
        handler: (...args: unknown[]) => void,
      ) => {
        if (typeof autoUpdater.off === "function") {
          autoUpdater.off(event, handler);
        } else if (typeof autoUpdater.removeListener === "function") {
          autoUpdater.removeListener(event, handler);
        }
      };
      for (const [event, handler] of listeners) {
        remove(event, handler);
      }
      listeners.clear();
    },
  };

  return controller;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function assertSignatureVerificationEnabled(
  autoUpdater: ElectronUpdaterLike,
): void {
  const value = (autoUpdater as { disableSignatureVerification?: unknown })
    .disableSignatureVerification;
  if (value === true) {
    throw new Error(
      "refusing to start updater: disableSignatureVerification is true. " +
        "Signature verification is required by DS5 contract.",
    );
  }
}
