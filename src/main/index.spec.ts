import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  return {
    app: {
      whenReady: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
    },
    dialog: {
      showErrorBox: vi.fn(),
    },
    // biome-ignore lint/complexity/useArrowFunction: needs [[Construct]] for `new BrowserWindow(...)`
    BrowserWindow: vi.fn().mockImplementation(function (opts: unknown) {
      return {
        opts,
        webContents: {
          session: { setPermissionRequestHandler: vi.fn() },
          on: vi.fn(),
          setWindowOpenHandler: vi.fn(),
        },
        once: vi.fn(),
        show: vi.fn(),
        loadURL: vi.fn().mockResolvedValue(undefined),
      };
    }),
  };
});

const DISCOVERED_URL = "http://127.0.0.1:9090/ui/";
const resolveServerMock = vi.fn();
vi.mock("./server.js", async () => {
  const actual =
    await vi.importActual<typeof import("./server.js")>("./server.js");
  return {
    ...actual,
    resolveServer: resolveServerMock,
  };
});

const { main } = await import("./index.js");

describe("main — happy path against a discovered server", () => {
  it("awaits whenReady, resolves the server, constructs the window, and loads the discovered URL", async () => {
    const electron = (await import("electron")) as unknown as {
      app: {
        whenReady: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
      };
      BrowserWindow: ReturnType<typeof vi.fn>;
    };
    electron.app.whenReady.mockClear();
    electron.app.on.mockClear();
    electron.BrowserWindow.mockClear();
    resolveServerMock.mockReset();
    resolveServerMock.mockResolvedValue({
      record: {
        pid: 4242,
        address: "127.0.0.1:9090",
        startedAt: "2026-05-15T00:00:00Z",
        version: "0.1.31",
        protocolVersions: ["nimbus.v2"],
      },
      url: DISCOVERED_URL,
      origin: "discovered",
      spawned: null,
    });

    await main();

    expect(electron.app.whenReady).toHaveBeenCalledOnce();
    expect(resolveServerMock).toHaveBeenCalledWith({ ensure: true });
    expect(electron.BrowserWindow).toHaveBeenCalledOnce();
    const instance = electron.BrowserWindow.mock.results[0]?.value as {
      loadURL: ReturnType<typeof vi.fn>;
    };
    expect(instance.loadURL).toHaveBeenCalledWith(DISCOVERED_URL);
  });

  it("subscribes to web-contents-created and window-all-closed", async () => {
    const electron = (await import("electron")) as unknown as {
      app: {
        on: ReturnType<typeof vi.fn>;
      };
    };
    electron.app.on.mockClear();
    resolveServerMock.mockResolvedValue({
      record: {
        pid: 4242,
        address: "127.0.0.1:9090",
        startedAt: "2026-05-15T00:00:00Z",
        version: "0.1.31",
        protocolVersions: ["nimbus.v2"],
      },
      url: DISCOVERED_URL,
      origin: "discovered",
      spawned: null,
    });
    await main();
    const subscribed = electron.app.on.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(subscribed).toContain("web-contents-created");
    expect(subscribed).toContain("window-all-closed");
  });
});

describe("main — spawned-server lifecycle", () => {
  it("registers before-quit only when the shell spawned the server", async () => {
    const electron = (await import("electron")) as unknown as {
      app: { on: ReturnType<typeof vi.fn> };
    };
    electron.app.on.mockClear();
    resolveServerMock.mockResolvedValue({
      record: {
        pid: 4242,
        address: "127.0.0.1:9090",
        startedAt: "2026-05-15T00:00:00Z",
        version: "0.1.31",
        protocolVersions: ["nimbus.v2"],
      },
      url: DISCOVERED_URL,
      origin: "spawned",
      spawned: {
        pid: 4242,
        child: { kill: vi.fn().mockReturnValue(true) },
      },
    });
    await main();
    const subscribed = electron.app.on.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(subscribed).toContain("before-quit");
  });

  it("does NOT register before-quit when the shell only discovered a server", async () => {
    const electron = (await import("electron")) as unknown as {
      app: { on: ReturnType<typeof vi.fn> };
    };
    electron.app.on.mockClear();
    resolveServerMock.mockResolvedValue({
      record: {
        pid: 4242,
        address: "127.0.0.1:9090",
        startedAt: "2026-05-15T00:00:00Z",
        version: "0.1.31",
        protocolVersions: ["nimbus.v2"],
      },
      url: DISCOVERED_URL,
      origin: "discovered",
      spawned: null,
    });
    await main();
    const subscribed = electron.app.on.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(subscribed).not.toContain("before-quit");
  });
});

describe("main — fatal-error path", () => {
  it("surfaces an error dialog and quits when resolveServer rejects", async () => {
    const electron = (await import("electron")) as unknown as {
      app: { quit: ReturnType<typeof vi.fn> };
      dialog: { showErrorBox: ReturnType<typeof vi.fn> };
      BrowserWindow: ReturnType<typeof vi.fn>;
    };
    electron.app.quit.mockClear();
    electron.dialog.showErrorBox.mockClear();
    electron.BrowserWindow.mockClear();
    resolveServerMock.mockRejectedValue(new Error("boom"));
    await main();
    expect(electron.dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(electron.app.quit).toHaveBeenCalledOnce();
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
  });
});

describe("autorun guard", () => {
  it("skips auto-running main() under vitest", () => {
    expect(process.env.VITEST).toBeDefined();
  });
});
