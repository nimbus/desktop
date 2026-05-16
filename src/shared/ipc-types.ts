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
//
// DS1 ships an intentionally empty surface. The preload exposes an
// empty frozen `nimbusShell` object via `contextBridge.exposeInMainWorld`
// so the renderer DevTools probe can confirm the bridge is wired and
// that `process` is undefined (sandbox proof).

export type IpcChannelName = never;

export interface NimbusShell {
  readonly __version: "ds1";
}

declare global {
  interface Window {
    readonly nimbusShell: NimbusShell;
  }
}
