import { describe, expect, it, vi } from "vitest";

import type { NimbusShell, UpdaterStateChange } from "../shared/ipc-types.js";

const mod = (await import("./index.cjs")) as unknown as {
  default?: {
    buildShell: (ipc: FakeIpc) => NimbusShell;
    installNimbusShell: (
      bridge: { exposeInMainWorld: (name: string, value: unknown) => void },
      ipc: FakeIpc,
    ) => unknown;
  };
  buildShell?: (ipc: FakeIpc) => NimbusShell;
  installNimbusShell?: (
    bridge: { exposeInMainWorld: (name: string, value: unknown) => void },
    ipc: FakeIpc,
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

type IpcListener = (event: unknown, ...args: unknown[]) => void;

interface FakeIpc {
  invoke: ReturnType<typeof vi.fn> &
    ((channel: string, ...args: unknown[]) => Promise<unknown>);
  on: ReturnType<typeof vi.fn> &
    ((channel: string, listener: IpcListener) => unknown);
  removeListener: ReturnType<typeof vi.fn> &
    ((channel: string, listener: IpcListener) => unknown);
  emit(channel: string, ...args: unknown[]): void;
}

function fakeIpc(): FakeIpc {
  const listeners = new Map<string, Set<IpcListener>>();
  const get = (channel: string) => {
    let bucket = listeners.get(channel);
    if (!bucket) {
      bucket = new Set();
      listeners.set(channel, bucket);
    }
    return bucket;
  };
  const ipc = {
    invoke: vi
      .fn()
      .mockResolvedValue(undefined) as unknown as FakeIpc["invoke"],
    on: vi.fn((channel: string, listener: IpcListener) => {
      get(channel).add(listener);
    }) as unknown as FakeIpc["on"],
    removeListener: vi.fn((channel: string, listener: IpcListener) => {
      get(channel).delete(listener);
    }) as unknown as FakeIpc["removeListener"],
    emit(channel: string, ...args: unknown[]) {
      for (const fn of get(channel)) {
        fn({ source: "test" }, ...args);
      }
    },
  };
  return ipc;
}

describe("nimbusShell preload surface", () => {
  it("pins __version to the current DS-item marker", () => {
    const shell = buildShell(fakeIpc());
    expect(shell.__version).toBe("ds5");
  });

  it("is frozen so the renderer cannot mutate the bridge surface", () => {
    const shell = buildShell(fakeIpc());
    expect(Object.isFrozen(shell)).toBe(true);
  });

  it("freezes the nested tray namespace so methods cannot be swapped", () => {
    const shell = buildShell(fakeIpc());
    expect(Object.isFrozen(shell.tray)).toBe(true);
  });

  it("freezes the nested updater namespace so methods cannot be swapped", () => {
    const shell = buildShell(fakeIpc());
    expect(Object.isFrozen(shell.updater)).toBe(true);
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

  it("updater.checkForUpdates invokes the documented IPC channel", () => {
    const ipc = fakeIpc();
    const shell = buildShell(ipc);
    void shell.updater.checkForUpdates();
    expect(ipc.invoke).toHaveBeenCalledWith("nimbus:updater:checkForUpdates");
  });

  it("updater.onStateChange subscribes on the state-changed channel and forwards events", () => {
    const ipc = fakeIpc();
    const shell = buildShell(ipc);
    const received: UpdaterStateChange[] = [];
    const dispose = shell.updater.onStateChange((change) => {
      received.push(change);
    });
    expect(ipc.on).toHaveBeenCalledTimes(1);
    expect(ipc.on.mock.calls[0]?.[0]).toBe("nimbus:updater:state-changed");
    ipc.emit("nimbus:updater:state-changed", { state: "checking" });
    ipc.emit("nimbus:updater:state-changed", {
      state: "available",
      version: "1.2.3",
    });
    expect(received).toEqual([
      { state: "checking" },
      { state: "available", version: "1.2.3" },
    ]);
    dispose();
    expect(ipc.removeListener).toHaveBeenCalledTimes(1);
    ipc.emit("nimbus:updater:state-changed", { state: "downloaded" });
    expect(received).toHaveLength(2);
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
    expect(exposed.__version).toBe("ds5");
  });
});
