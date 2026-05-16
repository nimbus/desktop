import { describe, expect, it, vi } from "vitest";

// The preload is a CJS module (`.cts` → `.cjs`) that ends with
// `module.exports = { nimbusShell, installNimbusShell }`. When ESM
// dynamic-imports a CJS module, Node/Vite exposes the CJS exports
// object on `.default`. Vite also synthesizes named exports for
// top-level CJS keys, so `mod.nimbusShell` / `mod.installNimbusShell`
// are the fallback path if `.default` is absent.
const mod = (await import("./index.cjs")) as unknown as {
  default?: {
    nimbusShell: { readonly __version: "ds1" };
    installNimbusShell: (bridge: {
      exposeInMainWorld: (name: string, value: unknown) => void;
    }) => void;
  };
  nimbusShell?: { readonly __version: "ds1" };
  installNimbusShell?: (bridge: {
    exposeInMainWorld: (name: string, value: unknown) => void;
  }) => void;
};
const resolved = mod.default ?? mod;
const nimbusShell = resolved.nimbusShell;
const installNimbusShell = resolved.installNimbusShell;
if (!nimbusShell || !installNimbusShell) {
  throw new Error(
    "preload module did not expose nimbusShell + installNimbusShell",
  );
}

describe("nimbusShell preload surface", () => {
  it("is the empty DS1 contextBridge object", () => {
    expect(nimbusShell).toEqual({ __version: "ds1" });
  });

  it("is frozen so the renderer cannot mutate the bridge surface", () => {
    expect(Object.isFrozen(nimbusShell)).toBe(true);
  });

  it("installNimbusShell exposes 'nimbusShell' on the supplied bridge", () => {
    const exposeInMainWorld = vi.fn();
    installNimbusShell({ exposeInMainWorld });
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(exposeInMainWorld).toHaveBeenCalledWith("nimbusShell", nimbusShell);
  });
});
