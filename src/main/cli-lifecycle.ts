import type { ChildProcess } from "node:child_process";

import type { BrowserWindow, IpcMain } from "electron";

import {
  type InstallMethod,
  isInstallMethod,
  isUpgradeMethod,
  NIMBUS_CAN_RUN_INSTALL_CHANNEL,
  NIMBUS_CAN_RUN_UPGRADE_CHANNEL,
  NIMBUS_CLI_NOT_FOUND_CHANNEL,
  NIMBUS_RETRY_RESOLVE_CLI_CHANNEL,
  NIMBUS_RUN_INSTALL_CHANNEL,
  NIMBUS_RUN_UPGRADE_CHANNEL,
  NIMBUS_STALENESS_CHANNEL,
  type StalenessInfo,
  type UpgradeMethod,
} from "../shared/ipc-types.js";
import { createIpcRouter } from "./ipc.js";
import {
  createStalenessNotifier,
  type StalenessNotifier,
} from "./notifications/staleness.js";
import { createUpgradeLifecycle } from "./upgrade/lifecycle.js";
import { createUpgradeRunner, type UpgradeRunner } from "./upgrade/runner.js";

// UL3: thin composition root for the nimbus-CLI lifecycle channels.
// Holds the runner, the lifecycle pump, the staleness notifier, and
// the post-upgrade restart hook in one place so `src/main/index.ts`
// remains a high-level startup script. The restart hook is injected
// by the caller (only `index.ts` knows the nimbus child handle + URL
// state and the window to reload).

export type RestartHook = () => Promise<{
  readonly newVersion: string;
  readonly newUrl: string;
}>;

export type RetryResolveHook = () => Promise<{ readonly ok: boolean }>;

export interface CliLifecycleDeps {
  readonly window: Pick<BrowserWindow, "isDestroyed" | "webContents">;
  readonly ipc: Pick<IpcMain, "handle">;
  readonly allowedOrigin: string;
  readonly serverUrl: string;
  readonly userDataDir: string;
  readonly restartHook: RestartHook;
  readonly retryResolveHook: RetryResolveHook;
  readonly Notification?:
    | (new (options: {
        readonly title: string;
        readonly body: string;
      }) => {
        show(): void;
        on(event: "click", listener: () => void): unknown;
      })
    | null;
  readonly onShow?: () => void;
  readonly runner?: UpgradeRunner;
  readonly notifier?: StalenessNotifier;
  readonly logger?: (message: string) => void;
}

export interface CliLifecycle {
  start(): void;
  stop(): void;
  signalCliNotFound(): void;
  // Test seam: drive a single staleness poll.
  pollStalenessOnce(): Promise<void>;
}

export function installCliLifecycle(deps: CliLifecycleDeps): CliLifecycle {
  const log = deps.logger ?? (() => {});
  const send = (channel: string, payload?: unknown): void => {
    if (deps.window.isDestroyed()) return;
    deps.window.webContents.send(channel, payload);
  };

  const runner =
    deps.runner ??
    createUpgradeRunner({
      onUpgradeSucceeded: async () => {
        const { newVersion } = await deps.restartHook();
        return { newVersion };
      },
    });

  const lifecycle = createUpgradeLifecycle({
    runner,
    emit: (channel, payload) => send(channel, payload),
    restartNimbus: async () => {
      const { newVersion, newUrl } = await deps.restartHook();
      // Returning the SpawnedServerHandle is awkward without
      // owning the spawn — the caller's restartHook handles the
      // child swap. We satisfy the interface by returning a
      // synthetic handle. The lifecycle does not actually use the
      // returned handle today; it exists for future symmetry.
      return {
        newVersion,
        url: newUrl,
        handle: {
          pid: -1,
          child: { kill: () => false } as unknown as ChildProcess,
        },
      };
    },
    logger: log,
  });

  const router = createIpcRouter({
    allowedOrigin: deps.allowedOrigin,
    ipc: deps.ipc,
    logger: log,
  });

  router.register<UpgradeMethod, boolean>(
    NIMBUS_CAN_RUN_UPGRADE_CHANNEL,
    async (_event, method) => {
      if (!isUpgradeMethod(method)) return false;
      return runner.canRunUpgrade(method);
    },
  );

  router.register<InstallMethod, boolean>(
    NIMBUS_CAN_RUN_INSTALL_CHANNEL,
    async (_event, method) => {
      if (!isInstallMethod(method)) return false;
      return runner.canRunInstall(method);
    },
  );

  router.register<
    { subscriptionId: string; method: UpgradeMethod },
    { ok: boolean; error?: string }
  >(NIMBUS_RUN_UPGRADE_CHANNEL, async (_event, payload) => {
    if (!payload || !isUpgradeMethod(payload.method)) {
      return { ok: false, error: "unknown method" };
    }
    const result = lifecycle.startUpgrade({
      subscriptionId: payload.subscriptionId,
      method: payload.method,
    });
    return result;
  });

  router.register<
    { subscriptionId: string; method: InstallMethod },
    { ok: boolean; error?: string }
  >(NIMBUS_RUN_INSTALL_CHANNEL, async (_event, payload) => {
    if (!payload || !isInstallMethod(payload.method)) {
      return { ok: false, error: "unknown method" };
    }
    const result = lifecycle.startInstall({
      subscriptionId: payload.subscriptionId,
      method: payload.method,
    });
    return result;
  });

  router.register<void, { ok: boolean }>(
    NIMBUS_RETRY_RESOLVE_CLI_CHANNEL,
    async () => {
      try {
        const result = await deps.retryResolveHook();
        return result;
      } catch (err) {
        log(`retryResolveCli failed: ${(err as Error).message}`);
        return { ok: false };
      }
    },
  );

  const notifier =
    deps.notifier ??
    createStalenessNotifier({
      serverUrl: deps.serverUrl,
      userDataDir: deps.userDataDir,
      Notification: deps.Notification ?? null,
      onClick: deps.onShow,
      onStaleness: (info: StalenessInfo) =>
        send(NIMBUS_STALENESS_CHANNEL, info),
      logger: log,
    });

  return {
    start() {
      notifier.start();
    },
    stop() {
      notifier.stop();
    },
    signalCliNotFound() {
      send(NIMBUS_CLI_NOT_FOUND_CHANNEL);
    },
    pollStalenessOnce() {
      return notifier.pollOnce();
    },
  };
}
