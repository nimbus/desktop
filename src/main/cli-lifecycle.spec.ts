import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { installCliLifecycle } from "./cli-lifecycle.js";
import type { UpgradeRunner } from "./upgrade/runner.js";

interface CapturedSend {
  channel: string;
  payload: unknown;
}

interface CapturedHandle {
  channel: string;
  fn: (event: IpcMainInvokeEvent, payload: unknown) => unknown;
}

function fakeWindow(captured: CapturedSend[]) {
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, payload: unknown) => {
        captured.push({ channel, payload });
      },
    } as unknown as Electron.WebContents,
  };
}

function fakeIpc(handles: CapturedHandle[]): Pick<IpcMain, "handle"> {
  return {
    handle: (channel, fn) => {
      handles.push({
        channel,
        fn: fn as CapturedHandle["fn"],
      });
    },
  } as Pick<IpcMain, "handle">;
}

const fakeEvent = (url: string): IpcMainInvokeEvent =>
  ({ senderFrame: { url } }) as unknown as IpcMainInvokeEvent;

const ALLOWED = "http://127.0.0.1:8088/ui/";

function makeRunnerStub(): UpgradeRunner {
  return {
    async canRunUpgrade(method) {
      return method === "brew";
    },
    async canRunInstall(method) {
      return method === "brew";
    },
    runUpgrade() {
      return {
        async *[Symbol.asyncIterator]() {
          /* empty */
        },
      };
    },
    runInstall() {
      return {
        async *[Symbol.asyncIterator]() {
          /* empty */
        },
      };
    },
  };
}

describe("installCliLifecycle", () => {
  it("registers all UL3 cli channels on the supplied ipcMain", () => {
    const handles: CapturedHandle[] = [];
    const sends: CapturedSend[] = [];
    installCliLifecycle({
      window: fakeWindow(sends),
      ipc: fakeIpc(handles),
      allowedOrigin: ALLOWED,
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: "/tmp/nimbus-test",
      restartHook: vi.fn().mockResolvedValue({
        newVersion: "0.1.41",
        newUrl: "http://127.0.0.1:8088/ui/",
      }),
      retryResolveHook: vi.fn().mockResolvedValue({ ok: true }),
      runner: makeRunnerStub(),
      notifier: { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn() },
    });
    const channels = handles.map((h) => h.channel).sort();
    expect(channels).toEqual([
      "nimbus:cli:canRunInstall",
      "nimbus:cli:canRunUpgrade",
      "nimbus:cli:retryResolveCli",
      "nimbus:cli:runInstall",
      "nimbus:cli:runUpgrade",
    ]);
  });

  it("canRunUpgrade returns false for an unknown method tag without throwing", async () => {
    const handles: CapturedHandle[] = [];
    const sends: CapturedSend[] = [];
    installCliLifecycle({
      window: fakeWindow(sends),
      ipc: fakeIpc(handles),
      allowedOrigin: ALLOWED,
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: "/tmp/nimbus-test",
      restartHook: vi.fn(),
      retryResolveHook: vi.fn(),
      runner: makeRunnerStub(),
      notifier: { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn() },
    });
    const upgradeHandle = handles.find(
      (h) => h.channel === "nimbus:cli:canRunUpgrade",
    );
    expect(upgradeHandle).toBeDefined();
    // valid event from the allowed origin
    const result = await upgradeHandle?.fn(fakeEvent(ALLOWED), "drop-tables");
    expect(result).toBe(false);
  });

  it("canRunUpgrade('brew') is true when the runner agrees", async () => {
    const handles: CapturedHandle[] = [];
    installCliLifecycle({
      window: fakeWindow([]),
      ipc: fakeIpc(handles),
      allowedOrigin: ALLOWED,
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: "/tmp/nimbus-test",
      restartHook: vi.fn(),
      retryResolveHook: vi.fn(),
      runner: makeRunnerStub(),
      notifier: { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn() },
    });
    const upgradeHandle = handles.find(
      (h) => h.channel === "nimbus:cli:canRunUpgrade",
    );
    const result = await upgradeHandle?.fn(fakeEvent(ALLOWED), "brew");
    expect(result).toBe(true);
  });

  it("runUpgrade rejects an unknown method tag at the IPC boundary", async () => {
    const handles: CapturedHandle[] = [];
    installCliLifecycle({
      window: fakeWindow([]),
      ipc: fakeIpc(handles),
      allowedOrigin: ALLOWED,
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: "/tmp/nimbus-test",
      restartHook: vi.fn(),
      retryResolveHook: vi.fn(),
      runner: makeRunnerStub(),
      notifier: { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn() },
    });
    const runHandle = handles.find(
      (h) => h.channel === "nimbus:cli:runUpgrade",
    );
    const result = (await runHandle?.fn(fakeEvent(ALLOWED), {
      subscriptionId: "x",
      method: "drop-tables",
    })) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
  });

  it("signalCliNotFound emits on the notFound channel", () => {
    const handles: CapturedHandle[] = [];
    const sends: CapturedSend[] = [];
    const lifecycle = installCliLifecycle({
      window: fakeWindow(sends),
      ipc: fakeIpc(handles),
      allowedOrigin: ALLOWED,
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: "/tmp/nimbus-test",
      restartHook: vi.fn(),
      retryResolveHook: vi.fn(),
      runner: makeRunnerStub(),
      notifier: { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn() },
    });
    lifecycle.signalCliNotFound();
    expect(sends).toEqual([
      { channel: "nimbus:cli:notFound", payload: undefined },
    ]);
  });

  it("start / stop forward to the underlying staleness notifier", () => {
    const notifier = { start: vi.fn(), stop: vi.fn(), pollOnce: vi.fn() };
    const lifecycle = installCliLifecycle({
      window: fakeWindow([]),
      ipc: fakeIpc([]),
      allowedOrigin: ALLOWED,
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: "/tmp/nimbus-test",
      restartHook: vi.fn(),
      retryResolveHook: vi.fn(),
      runner: makeRunnerStub(),
      notifier,
    });
    lifecycle.start();
    expect(notifier.start).toHaveBeenCalledOnce();
    lifecycle.stop();
    expect(notifier.stop).toHaveBeenCalledOnce();
  });
});
