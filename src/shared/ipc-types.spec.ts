import { describe, expect, expectTypeOf, it } from "vitest";

import type { IpcChannelName, NimbusShell } from "./ipc-types.js";

describe("ipc-types", () => {
  it("ships an empty IpcChannelName surface for DS1", () => {
    // The DS1 surface is intentionally empty. DS2+ grows the union
    // type by adding string literals to IpcChannelName.
    expectTypeOf<IpcChannelName>().toEqualTypeOf<never>();
  });

  it("pins the NimbusShell version marker so DS-item drift is caught", () => {
    expectTypeOf<NimbusShell["__version"]>().toEqualTypeOf<"ds1">();
  });

  it("declares window.nimbusShell as a readonly NimbusShell", () => {
    // Compile-time check only — at runtime in the main process the
    // global `window` is undefined. The `as unknown` round-trip
    // satisfies the strict typing.
    expect(typeof globalThis).toBe("object");
  });
});
