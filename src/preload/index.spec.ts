import { describe, expect, it, vi } from "vitest";

import type {
  NimbusCli,
  NimbusShell,
  RunnerEvent,
  StalenessInfo,
  UpdaterStateChange,
} from "../shared/ipc-types.js";

const mod = (await import("./index.cjs")) as unknown as {
  default?: {
    buildShell: (ipc: FakeIpc) => NimbusShell;
    buildCli: (ipc: FakeIpc) => NimbusCli;
    installNimbusShell: (
      bridge: { exposeInMainWorld: (name: string, value: unknown) => void },
      ipc: FakeIpc,
    ) => unknown;
  };
  buildShell?: (ipc: FakeIpc) => NimbusShell;
  buildCli?: (ipc: FakeIpc) => NimbusCli;
  installNimbusShell?: (
    bridge: { exposeInMainWorld: (name: string, value: unknown) => void },
    ipc: FakeIpc,
  ) => unknown;
};
const resolved = mod.default ?? mod;
const buildShell = resolved.buildShell;
const buildCli = resolved.buildCli;
const installNimbusShell = resolved.installNimbusShell;
if (!buildShell || !buildCli || !installNimbusShell) {
  throw new Error(
    "preload module did not expose buildShell + buildCli + installNimbusShell",
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

  it("installNimbusShell exposes both 'nimbusShell' (DS5) and 'nimbus' (UL3) on the supplied bridge", () => {
    const exposeInMainWorld = vi.fn();
    const ipc = fakeIpc();
    installNimbusShell({ exposeInMainWorld }, ipc);
    expect(exposeInMainWorld).toHaveBeenCalledTimes(2);
    const names = exposeInMainWorld.mock.calls.map((call) => call[0]);
    expect(names).toEqual(["nimbusShell", "nimbus"]);
    const shellExposed = exposeInMainWorld.mock.calls[0]?.[1] as {
      __version: string;
    };
    expect(shellExposed.__version).toBe("ds5");
    const cliExposed = exposeInMainWorld.mock.calls[1]?.[1] as {
      __version: string;
    };
    expect(cliExposed.__version).toBe("ul3");
  });
});

describe("nimbus CLI preload surface (UL3)", () => {
  it("pins __version to the UL marker", () => {
    const cli = buildCli(fakeIpc());
    expect(cli.__version).toBe("ul3");
  });

  it("is frozen at the top level", () => {
    const cli = buildCli(fakeIpc());
    expect(Object.isFrozen(cli)).toBe(true);
  });

  it("canRunUpgrade invokes the documented channel with the method tag", async () => {
    const ipc = fakeIpc();
    ipc.invoke.mockResolvedValue(true);
    const cli = buildCli(ipc);
    const result = await cli.canRunUpgrade("brew");
    expect(ipc.invoke).toHaveBeenCalledWith("nimbus:cli:canRunUpgrade", "brew");
    expect(result).toBe(true);
  });

  it("canRunInstall invokes the documented channel with the method tag", async () => {
    const ipc = fakeIpc();
    ipc.invoke.mockResolvedValue(false);
    const cli = buildCli(ipc);
    const result = await cli.canRunInstall("install-script");
    expect(ipc.invoke).toHaveBeenCalledWith(
      "nimbus:cli:canRunInstall",
      "install-script",
    );
    expect(result).toBe(false);
  });

  it("retryResolveCli invokes the documented channel", async () => {
    const ipc = fakeIpc();
    ipc.invoke.mockResolvedValue({ ok: true });
    const cli = buildCli(ipc);
    const result = await cli.retryResolveCli();
    expect(ipc.invoke).toHaveBeenCalledWith("nimbus:cli:retryResolveCli");
    expect(result.ok).toBe(true);
  });

  it("onStaleness subscribes to the staleness channel and forwards info objects", () => {
    const ipc = fakeIpc();
    const cli = buildCli(ipc);
    const received: StalenessInfo[] = [];
    const dispose = cli.onStaleness((info) => {
      received.push(info);
    });
    const info: StalenessInfo = {
      current: "0.1.40",
      latest: "0.1.41",
      available: true,
      url: null,
      host: "localhost",
    };
    ipc.emit("nimbus:cli:staleness", info);
    expect(received).toEqual([info]);
    dispose();
    ipc.emit("nimbus:cli:staleness", info);
    expect(received).toHaveLength(1);
  });

  it("onCliNotFound subscribes to the cli-not-found channel", () => {
    const ipc = fakeIpc();
    const cli = buildCli(ipc);
    const handler = vi.fn();
    const dispose = cli.onCliNotFound(handler);
    ipc.emit("nimbus:cli:notFound");
    expect(handler).toHaveBeenCalledTimes(1);
    dispose();
    ipc.emit("nimbus:cli:notFound");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runUpgrade dispatches the runner-start invoke with the method tag and a subscription id", async () => {
    const ipc = fakeIpc();
    ipc.invoke.mockResolvedValue({ ok: true });
    const cli = buildCli(ipc);
    const iterable = cli.runUpgrade("brew");
    const iter = iterable[Symbol.asyncIterator]();
    // synchronously after starting, the invoke must have been called
    // with the runUpgrade channel and a payload carrying the method
    await Promise.resolve();
    expect(ipc.invoke).toHaveBeenCalledTimes(1);
    const call = ipc.invoke.mock.calls[0] as [
      string,
      { subscriptionId: string; method: string },
    ];
    expect(call[0]).toBe("nimbus:cli:runUpgrade");
    expect(call[1].method).toBe("brew");
    expect(typeof call[1].subscriptionId).toBe("string");
    // close out the iterator so vitest doesn't leak the listener
    await iter.return?.({} as never);
  });

  it("runUpgrade ignores envelope events with a different subscription id", async () => {
    const ipc = fakeIpc();
    ipc.invoke.mockResolvedValue({ ok: true });
    const cli = buildCli(ipc);
    const iter = cli.runUpgrade("brew")[Symbol.asyncIterator]();
    await Promise.resolve();
    const sentSubId = (
      ipc.invoke.mock.calls[0]?.[1] as { subscriptionId: string }
    ).subscriptionId;
    // emit a foreign envelope
    ipc.emit("nimbus:cli:runnerEvent", {
      subscriptionId: "someone-else",
      event: { kind: "stdout", line: "ignore me" } as RunnerEvent,
    });
    // emit our own
    ipc.emit("nimbus:cli:runnerEvent", {
      subscriptionId: sentSubId,
      event: { kind: "stdout", line: "ours" } as RunnerEvent,
    });
    ipc.emit("nimbus:cli:runnerEvent", {
      subscriptionId: sentSubId,
      event: { kind: "restarted", newVersion: "0.1.41" } as RunnerEvent,
    });
    const events: RunnerEvent[] = [];
    while (true) {
      const result = await iter.next();
      if (result.done) break;
      events.push(result.value);
    }
    const lines = events
      .filter((e): e is RunnerEvent & { kind: "stdout" } => e.kind === "stdout")
      .map((e) => e.line);
    expect(lines).toEqual(["ours"]);
    expect(events.some((e) => e.kind === "restarted")).toBe(true);
  });
});
