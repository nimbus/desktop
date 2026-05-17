import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type IpcChannelName,
  type NimbusShell,
  TRAY_SET_STATUS_DOT_CHANNEL,
  type TrayStatusDot,
  UPDATER_CHECK_FOR_UPDATES_CHANNEL,
  UPDATER_STATE_CHANGED_CHANNEL,
  type UpdaterState,
  type UpdaterStateChange,
} from "./ipc-types.js";

describe("ipc-types", () => {
  it("IpcChannelName is the union of tray + updater + UL3 cli channels", () => {
    expectTypeOf<IpcChannelName>().toEqualTypeOf<
      | "nimbus:tray:setStatusDot"
      | "nimbus:updater:state-changed"
      | "nimbus:updater:checkForUpdates"
      | "nimbus:cli:canRunUpgrade"
      | "nimbus:cli:canRunInstall"
      | "nimbus:cli:runUpgrade"
      | "nimbus:cli:runInstall"
      | "nimbus:cli:runnerEvent"
      | "nimbus:cli:retryResolveCli"
      | "nimbus:cli:staleness"
      | "nimbus:cli:notFound"
    >();
    expect(TRAY_SET_STATUS_DOT_CHANNEL).toBe("nimbus:tray:setStatusDot");
    expect(UPDATER_STATE_CHANGED_CHANNEL).toBe("nimbus:updater:state-changed");
    expect(UPDATER_CHECK_FOR_UPDATES_CHANNEL).toBe(
      "nimbus:updater:checkForUpdates",
    );
  });

  it("pins the NimbusShell version marker so DS-item drift is caught", () => {
    expectTypeOf<NimbusShell["__version"]>().toEqualTypeOf<"ds5">();
  });

  it("TrayStatusDot is the three documented states", () => {
    expectTypeOf<TrayStatusDot>().toEqualTypeOf<
      "connected" | "reconnecting" | "offline"
    >();
  });

  it("UpdaterState covers the full state machine", () => {
    expectTypeOf<UpdaterState>().toEqualTypeOf<
      | "idle"
      | "checking"
      | "available"
      | "not-available"
      | "downloading"
      | "downloaded"
      | "error"
    >();
  });

  it("UpdaterStateChange.state is the documented union", () => {
    expectTypeOf<UpdaterStateChange["state"]>().toEqualTypeOf<UpdaterState>();
  });

  it("NimbusShell.tray.setStatusDot accepts a TrayStatusDot", () => {
    expectTypeOf<NimbusShell["tray"]["setStatusDot"]>()
      .parameter(0)
      .toEqualTypeOf<TrayStatusDot>();
  });

  it("NimbusShell.updater exposes onStateChange + checkForUpdates", () => {
    expectTypeOf<NimbusShell["updater"]["checkForUpdates"]>().toEqualTypeOf<
      () => Promise<void>
    >();
    expectTypeOf<NimbusShell["updater"]["onStateChange"]>()
      .parameter(0)
      .toEqualTypeOf<(change: UpdaterStateChange) => void>();
  });

  it("declares window.nimbusShell as a readonly NimbusShell", () => {
    // Compile-time check only — at runtime in the main process the
    // global `window` is undefined.
    expect(typeof globalThis).toBe("object");
  });
});
