// src/preload/index.cts — CommonJS preload.
//
// Electron's sandboxed preload runtime does not support ES modules,
// so this file is CommonJS via the `.cts` extension. The main process
// + shared types remain ESM.
//
// Two surfaces:
//   - `window.nimbusShell` (DS5): tray dot + electron-updater state
//   - `window.nimbus` (UL3): nimbus CLI lifecycle — capability probes,
//     background upgrade/install runner, retry-resolve, OS-staleness
//     fan-out, cli-not-found gate.
//
// Both expose only narrow, typed surfaces; the renderer cannot
// smuggle a command string through.

import type { ContextBridge, IpcRenderer } from "electron";
import type {
  InstallMethod,
  NimbusCli,
  NimbusShell,
  RunnerEvent,
  RunnerEventEnvelope,
  StalenessInfo,
  StalenessListener,
  TrayStatusDot,
  UpdaterStateChange,
  UpdaterStateListener,
  UpgradeMethod,
} from "../shared/ipc-types";

const TRAY_CHANNEL = "nimbus:tray:setStatusDot";
const UPDATER_STATE_CHANGED_CHANNEL = "nimbus:updater:state-changed";
const UPDATER_CHECK_FOR_UPDATES_CHANNEL = "nimbus:updater:checkForUpdates";

const CAN_RUN_UPGRADE_CHANNEL = "nimbus:cli:canRunUpgrade";
const CAN_RUN_INSTALL_CHANNEL = "nimbus:cli:canRunInstall";
const RUN_UPGRADE_CHANNEL = "nimbus:cli:runUpgrade";
const RUN_INSTALL_CHANNEL = "nimbus:cli:runInstall";
const RUNNER_EVENT_CHANNEL = "nimbus:cli:runnerEvent";
const RETRY_RESOLVE_CLI_CHANNEL = "nimbus:cli:retryResolveCli";
const STALENESS_CHANNEL = "nimbus:cli:staleness";
const CLI_NOT_FOUND_CHANNEL = "nimbus:cli:notFound";

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

function makeSubscriptionId(): string {
  // The renderer doesn't have crypto.randomUUID in every Electron
  // version under sandboxed preload, so we synthesize a short
  // monotonic-ish id. Collisions across renderers don't matter — the
  // main process tags events with the same id we send, and we filter
  // local events by id.
  return `ul3-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function runnerStream(
  ipc: IpcRenderer,
  channel: string,
  method: UpgradeMethod | InstallMethod,
): AsyncIterable<RunnerEvent> {
  const subscriptionId = makeSubscriptionId();
  return {
    [Symbol.asyncIterator]() {
      const queue: RunnerEvent[] = [];
      let resolveWake: (() => void) | null = null;
      let done = false;
      const wake = () => {
        const r = resolveWake;
        resolveWake = null;
        r?.();
      };
      const listener = (_event: unknown, payload: RunnerEventEnvelope) => {
        if (payload.subscriptionId !== subscriptionId) return;
        queue.push(payload.event);
        if (payload.event.kind === "exit" || payload.event.kind === "error") {
          // Terminal kinds: the main side may still emit `restarted`
          // after `exit` for upgrades, so we don't close here — we
          // close on a sentinel `end` we never send. The main side
          // closes by stopping emissions; we close on the
          // `restarted` event for upgrades, and on `error` for
          // anything else. Simpler: leave it open and let the
          // for-await loop decide via the kind sequence.
        }
        if (payload.event.kind === "restarted") {
          done = true;
        }
        // For non-upgrade runs (install), the runner doesn't emit a
        // `restarted` event, so `exit` is terminal.
        wake();
      };
      ipc.on(RUNNER_EVENT_CHANNEL, listener);

      const start = ipc.invoke(channel, { subscriptionId, method }) as Promise<{
        readonly ok: boolean;
        readonly error?: string;
      }>;
      void start.then((result) => {
        if (!result.ok) {
          queue.push({
            kind: "error",
            message: result.error ?? "runner refused to start",
            fallback: "copy",
          });
          done = true;
          wake();
        }
      });

      let lastWasExit = false;
      return {
        async next(): Promise<IteratorResult<RunnerEvent>> {
          while (true) {
            if (queue.length > 0) {
              const value = queue.shift();
              if (!value) continue;
              // For installs, exit is terminal; for upgrades we stay
              // open after exit so the runner can emit `restarted`.
              if (value.kind === "exit") {
                if (channel === RUN_INSTALL_CHANNEL) {
                  done = true;
                }
                lastWasExit = true;
              }
              if (value.kind === "restarted") {
                done = true;
              }
              return { value, done: false };
            }
            if (done && queue.length === 0) {
              ipc.removeListener(RUNNER_EVENT_CHANNEL, listener);
              return { value: undefined as never, done: true };
            }
            // If we already emitted exit for an upgrade but the main
            // side never sends `restarted` (because the exit was
            // non-zero), close out after a short grace.
            if (lastWasExit && channel === RUN_UPGRADE_CHANNEL) {
              // Give the main side one event-loop tick to emit
              // `restarted`; if nothing arrives, close.
              await new Promise<void>((resolve) => {
                resolveWake = resolve;
                setTimeout(() => {
                  done = true;
                  wake();
                }, 50);
              });
              continue;
            }
            await new Promise<void>((resolve) => {
              resolveWake = resolve;
            });
          }
        },
        async return(): Promise<IteratorResult<RunnerEvent>> {
          done = true;
          ipc.removeListener(RUNNER_EVENT_CHANNEL, listener);
          return { value: undefined as never, done: true };
        },
      };
    },
  };
}

function buildCli(ipc: IpcRenderer): NimbusCli {
  return Object.freeze({
    __version: "ul3",
    canRunUpgrade: (method: UpgradeMethod) =>
      ipc.invoke(CAN_RUN_UPGRADE_CHANNEL, method) as Promise<boolean>,
    canRunInstall: (method: InstallMethod) =>
      ipc.invoke(CAN_RUN_INSTALL_CHANNEL, method) as Promise<boolean>,
    runUpgrade: (method: UpgradeMethod) =>
      runnerStream(ipc, RUN_UPGRADE_CHANNEL, method),
    runInstall: (method: InstallMethod) =>
      runnerStream(ipc, RUN_INSTALL_CHANNEL, method),
    retryResolveCli: () =>
      ipc.invoke(RETRY_RESOLVE_CLI_CHANNEL) as Promise<{ readonly ok: boolean }>,
    onStaleness: (listener: StalenessListener) => {
      const wrapped = (_event: unknown, info: StalenessInfo) => {
        listener(info);
      };
      ipc.on(STALENESS_CHANNEL, wrapped);
      return () => {
        ipc.removeListener(STALENESS_CHANNEL, wrapped);
      };
    },
    onCliNotFound: (listener: () => void) => {
      const wrapped = () => listener();
      ipc.on(CLI_NOT_FOUND_CHANNEL, wrapped);
      return () => {
        ipc.removeListener(CLI_NOT_FOUND_CHANNEL, wrapped);
      };
    },
  });
}

function installNimbusShell(
  bridge: ContextBridge,
  ipc: IpcRenderer,
): { shell: NimbusShell; cli: NimbusCli } {
  const shell = buildShell(ipc);
  const cli = buildCli(ipc);
  bridge.exposeInMainWorld("nimbusShell", shell);
  bridge.exposeInMainWorld("nimbus", cli);
  return { shell, cli };
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

module.exports = { buildShell, buildCli, installNimbusShell };
