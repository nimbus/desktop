// Canonical IPC channel + contextBridge surface registry for the
// Nimbus desktop shell.
//
// Two surfaces live on this preload:
//   - `window.nimbusShell` (DS5): desktop's own controls — tray dot,
//     electron-updater state for the desktop app.
//   - `window.nimbus` (UL3): the **nimbus CLI** lifecycle — capability
//     probes, background upgrade runner, install-from-empty setup
//     card, and main-process staleness notifications.
//
// Every channel that lands on the bridge MUST appear in IpcChannelName
// below. The router in `src/main/ipc.ts` validates each invoke against
// `event.senderFrame.url` and fails closed on mismatch.

export const TRAY_SET_STATUS_DOT_CHANNEL = "nimbus:tray:setStatusDot" as const;

export const UPDATER_STATE_CHANGED_CHANNEL =
  "nimbus:updater:state-changed" as const;

export const UPDATER_CHECK_FOR_UPDATES_CHANNEL =
  "nimbus:updater:checkForUpdates" as const;

// UL3: nimbus CLI lifecycle channels.
export const NIMBUS_CAN_RUN_UPGRADE_CHANNEL =
  "nimbus:cli:canRunUpgrade" as const;
export const NIMBUS_CAN_RUN_INSTALL_CHANNEL =
  "nimbus:cli:canRunInstall" as const;
export const NIMBUS_RUN_UPGRADE_CHANNEL = "nimbus:cli:runUpgrade" as const;
export const NIMBUS_RUN_INSTALL_CHANNEL = "nimbus:cli:runInstall" as const;
export const NIMBUS_RUNNER_EVENT_CHANNEL = "nimbus:cli:runnerEvent" as const;
export const NIMBUS_RETRY_RESOLVE_CLI_CHANNEL =
  "nimbus:cli:retryResolveCli" as const;
export const NIMBUS_STALENESS_CHANNEL = "nimbus:cli:staleness" as const;
export const NIMBUS_CLI_NOT_FOUND_CHANNEL = "nimbus:cli:notFound" as const;

export type IpcChannelName =
  | typeof TRAY_SET_STATUS_DOT_CHANNEL
  | typeof UPDATER_STATE_CHANGED_CHANNEL
  | typeof UPDATER_CHECK_FOR_UPDATES_CHANNEL
  | typeof NIMBUS_CAN_RUN_UPGRADE_CHANNEL
  | typeof NIMBUS_CAN_RUN_INSTALL_CHANNEL
  | typeof NIMBUS_RUN_UPGRADE_CHANNEL
  | typeof NIMBUS_RUN_INSTALL_CHANNEL
  | typeof NIMBUS_RUNNER_EVENT_CHANNEL
  | typeof NIMBUS_RETRY_RESOLVE_CLI_CHANNEL
  | typeof NIMBUS_STALENESS_CHANNEL
  | typeof NIMBUS_CLI_NOT_FOUND_CHANNEL;

export type TrayStatusDot = "connected" | "reconnecting" | "offline";

export type UpdaterState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdaterDownloadProgress {
  readonly bytesPerSecond: number;
  readonly percent: number;
  readonly transferred: number;
  readonly total: number;
}

export interface UpdaterStateChange {
  readonly state: UpdaterState;
  readonly version?: string;
  readonly releaseNotes?: string;
  readonly progress?: UpdaterDownloadProgress;
  readonly message?: string;
}

export type UpdaterStateListener = (change: UpdaterStateChange) => void;

// UL3: closed unions matching the server's `upgrade.method` set.
// The IPC boundary rejects any tag outside these unions; the renderer
// can only forward a tag (never a command string), and the main
// process maps the tag to a hardcoded argv table.
export type UpgradeMethod =
  | "brew"
  | "apt"
  | "dnf"
  | "install-script"
  | "source"
  | "unknown";

export type InstallMethod = "brew" | "install-script" | "manual";

export const UPGRADE_METHODS: readonly UpgradeMethod[] = [
  "brew",
  "apt",
  "dnf",
  "install-script",
  "source",
  "unknown",
] as const;

export const INSTALL_METHODS: readonly InstallMethod[] = [
  "brew",
  "install-script",
  "manual",
] as const;

export function isUpgradeMethod(value: unknown): value is UpgradeMethod {
  return (
    typeof value === "string" &&
    (UPGRADE_METHODS as readonly string[]).includes(value)
  );
}

export function isInstallMethod(value: unknown): value is InstallMethod {
  return (
    typeof value === "string" &&
    (INSTALL_METHODS as readonly string[]).includes(value)
  );
}

// A single runner emits an async sequence of these events to the
// renderer over the per-call subscription token. `restarted` only
// fires for upgrades (after the post-upgrade restart sequence in
// `src/main/server.ts`). `error` is terminal and signals that the
// renderer should fall back to the copy-only path.
export type RunnerEvent =
  | {
      readonly kind: "started";
      readonly method: UpgradeMethod | InstallMethod;
      readonly argv: readonly string[];
    }
  | { readonly kind: "stdout"; readonly line: string }
  | { readonly kind: "stderr"; readonly line: string }
  | {
      readonly kind: "exit";
      readonly code: number;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly kind: "restarted"; readonly newVersion: string }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly fallback: "copy";
    };

// Wire-level message: the renderer subscribes once via
// `runUpgrade(method)` / `runInstall(method)`, gets a subscription
// token, and the main process tags every outgoing event with that
// token so concurrent calls (rare but possible across windows) stay
// isolated.
export interface RunnerEventEnvelope {
  readonly subscriptionId: string;
  readonly event: RunnerEvent;
}

// Subset of the server's `/api/system/version-info` shape that the
// main process consumes for the OS notification toast. The full shape
// lives in `packages/nimbus-ui/src/api/system.ts`; the main process
// only needs the fields that drive the dedupe and the toast body.
export interface StalenessInfo {
  readonly current: string;
  readonly latest: string | null;
  readonly available: boolean;
  readonly url: string | null;
  readonly host: string;
}

export type StalenessListener = (info: StalenessInfo) => void;

export interface NimbusShell {
  readonly __version: "ds5";
  readonly tray: {
    readonly setStatusDot: (state: TrayStatusDot) => Promise<void>;
  };
  readonly updater: {
    readonly onStateChange: (listener: UpdaterStateListener) => () => void;
    readonly checkForUpdates: () => Promise<void>;
  };
}

// UL3: the **nimbus CLI** lifecycle surface. Distinct from
// `NimbusShell` above which owns the desktop app's own updater.
export interface NimbusCli {
  readonly __version: "ul3";
  readonly canRunUpgrade: (method: UpgradeMethod) => Promise<boolean>;
  readonly canRunInstall: (method: InstallMethod) => Promise<boolean>;
  readonly runUpgrade: (method: UpgradeMethod) => AsyncIterable<RunnerEvent>;
  readonly runInstall: (method: InstallMethod) => AsyncIterable<RunnerEvent>;
  readonly retryResolveCli: () => Promise<{ readonly ok: boolean }>;
  readonly onStaleness: (listener: StalenessListener) => () => void;
  readonly onCliNotFound: (listener: () => void) => () => void;
}

declare global {
  interface Window {
    readonly nimbusShell: NimbusShell;
    readonly nimbus: NimbusCli;
  }
}
