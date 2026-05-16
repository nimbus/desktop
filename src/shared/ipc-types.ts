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

export type IpcChannelName = typeof TRAY_SET_STATUS_DOT_CHANNEL;

export type TrayStatusDot = "connected" | "reconnecting" | "offline";

export interface NimbusShell {
  readonly __version: "ds4";
  readonly tray: {
    readonly setStatusDot: (state: TrayStatusDot) => Promise<void>;
  };
}

declare global {
  interface Window {
    readonly nimbusShell: NimbusShell;
  }
}
