// Canonical IPC channel + contextBridge surface registry for the
// Nimbus desktop shell.
//
// Every channel that lands on the bridge MUST appear here. DS2-DS5
// grow this surface incrementally:
//   - DS2 adds server-lifecycle channels (start/stop/restart/status,
//     discovered-url, discovery-changed)
//   - DS3 adds the IpcMain handler middleware that validates each
//     channel against `event.senderFrame.url`
//   - DS4 adds window + tray channels
//   - DS5 adds updater channels

export const TRAY_SET_STATUS_DOT_CHANNEL = "nimbus:tray:setStatusDot" as const;

export const UPDATER_STATE_CHANGED_CHANNEL =
  "nimbus:updater:state-changed" as const;

export const UPDATER_CHECK_FOR_UPDATES_CHANNEL =
  "nimbus:updater:checkForUpdates" as const;

export type IpcChannelName =
  | typeof TRAY_SET_STATUS_DOT_CHANNEL
  | typeof UPDATER_STATE_CHANGED_CHANNEL
  | typeof UPDATER_CHECK_FOR_UPDATES_CHANNEL;

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

declare global {
  interface Window {
    readonly nimbusShell: NimbusShell;
  }
}
