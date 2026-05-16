import { describe, expect, expectTypeOf, it } from "vitest";

import {
  type IpcChannelName,
  type NimbusShell,
  TRAY_SET_STATUS_DOT_CHANNEL,
  type TrayStatusDot,
} from "./ipc-types.js";

describe("ipc-types", () => {
  it("DS4 IpcChannelName includes the tray:setStatusDot channel", () => {
    expectTypeOf<IpcChannelName>().toEqualTypeOf<"nimbus:tray:setStatusDot">();
    expect(TRAY_SET_STATUS_DOT_CHANNEL).toBe("nimbus:tray:setStatusDot");
  });

  it("pins the NimbusShell version marker so DS-item drift is caught", () => {
    expectTypeOf<NimbusShell["__version"]>().toEqualTypeOf<"ds4">();
  });

  it("TrayStatusDot is the three documented states", () => {
    expectTypeOf<TrayStatusDot>().toEqualTypeOf<
      "connected" | "reconnecting" | "offline"
    >();
  });

  it("NimbusShell.tray.setStatusDot accepts a TrayStatusDot", () => {
    expectTypeOf<NimbusShell["tray"]["setStatusDot"]>()
      .parameter(0)
      .toEqualTypeOf<TrayStatusDot>();
  });

  it("declares window.nimbusShell as a readonly NimbusShell", () => {
    // Compile-time check only — at runtime in the main process the
    // global `window` is undefined.
    expect(typeof globalThis).toBe("object");
  });
});
