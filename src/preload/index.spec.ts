import { describe, expect, it, vi } from "vitest";

const mod = (await import("./index.cjs")) as unknown as {
  default?: {
    buildShell: (ipc: {
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    }) => {
      readonly __version: "ds4";
      readonly tray: {
        readonly setStatusDot: (state: string) => Promise<unknown>;
      };
    };
    installNimbusShell: (
      bridge: { exposeInMainWorld: (name: string, value: unknown) => void },
      ipc: {
        invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
      },
    ) => unknown;
  };
  buildShell?: (ipc: {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  }) => {
    readonly __version: "ds4";
    readonly tray: {
      readonly setStatusDot: (state: string) => Promise<unknown>;
    };
  };
  installNimbusShell?: (
    bridge: { exposeInMainWorld: (name: string, value: unknown) => void },
    ipc: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> },
  ) => unknown;
};
const resolved = mod.default ?? mod;
const buildShell = resolved.buildShell;
const installNimbusShell = resolved.installNimbusShell;
if (!buildShell || !installNimbusShell) {
  throw new Error(
    "preload module did not expose buildShell + installNimbusShell",
  );
}

interface FakeIpc {
  invoke: ReturnType<typeof vi.fn> &
    ((channel: string, ...args: unknown[]) => Promise<unknown>);
}

function fakeIpc(): FakeIpc {
  return {
    invoke: vi.fn().mockResolvedValue(undefined) as unknown as FakeIpc["invoke"],
  };
}

describe("nimbusShell preload surface", () => {
  it("pins __version to the current DS-item marker", () => {
    const shell = buildShell(fakeIpc());
    expect(shell.__version).toBe("ds4");
  });

  it("is frozen so the renderer cannot mutate the bridge surface", () => {
    const shell = buildShell(fakeIpc());
    expect(Object.isFrozen(shell)).toBe(true);
  });

  it("freezes the nested tray namespace so methods cannot be swapped", () => {
    const shell = buildShell(fakeIpc());
    expect(Object.isFrozen(shell.tray)).toBe(true);
  });

  it("tray.setStatusDot invokes the documented IPC channel with the payload", () => {
    const ipc = fakeIpc();
    const shell = buildShell(ipc);
    void shell.tray.setStatusDot("connected");
    expect(ipc.invoke).toHaveBeenCalledWith(
      "nimbus:tray:setStatusDot",
      "connected",
    );
  });

  it("installNimbusShell exposes 'nimbusShell' on the supplied bridge", () => {
    const exposeInMainWorld = vi.fn();
    const ipc = fakeIpc();
    installNimbusShell({ exposeInMainWorld }, ipc);
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(exposeInMainWorld.mock.calls[0]?.[0]).toBe("nimbusShell");
    const exposed = exposeInMainWorld.mock.calls[0]?.[1] as {
      __version: string;
    };
    expect(exposed.__version).toBe("ds4");
  });
});
