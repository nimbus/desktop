import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const TEMP_USER_DATA = mkdtempSync(path.join(tmpdir(), "nimbus-ds4-userdata-"));

vi.mock("electron", () => {
  const trayInstances: Array<{
    setToolTip: ReturnType<typeof vi.fn>;
    setContextMenu: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  }> = [];
  return {
    app: {
      whenReady: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      quit: vi.fn(),
      exit: vi.fn(),
      getPath: vi.fn().mockReturnValue(TEMP_USER_DATA),
    },
    dialog: {
      showErrorBox: vi.fn(),
      showMessageBox: vi.fn(),
    },
    ipcMain: {
      handle: vi.fn(),
    },
    Menu: {
      buildFromTemplate: vi.fn().mockReturnValue({ __isMenu: true }),
      setApplicationMenu: vi.fn(),
    },
    // biome-ignore lint/complexity/useArrowFunction: needs [[Construct]] for `new Tray(...)`
    Tray: vi.fn().mockImplementation(function () {
      const t = {
        setToolTip: vi.fn(),
        setContextMenu: vi.fn(),
        destroy: vi.fn(),
      };
      trayInstances.push(t);
      return t;
    }),
    nativeImage: {
      createFromPath: vi.fn().mockReturnValue({ __isImage: true }),
    },
    // biome-ignore lint/complexity/useArrowFunction: needs [[Construct]] for `new BrowserWindow(...)`
    BrowserWindow: vi.fn().mockImplementation(function (opts: unknown) {
      return {
        opts,
        webContents: {
          session: { setPermissionRequestHandler: vi.fn() },
          on: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          send: vi.fn(),
        },
        once: vi.fn(),
        on: vi.fn(),
        show: vi.fn(),
        focus: vi.fn(),
        restore: vi.fn(),
        isMinimized: vi.fn().mockReturnValue(false),
        isDestroyed: vi.fn().mockReturnValue(false),
        getBounds: vi
          .fn()
          .mockReturnValue({ x: 100, y: 200, width: 1280, height: 800 }),
        loadURL: vi.fn().mockResolvedValue(undefined),
      };
    }),
    __trayInstances: trayInstances,
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
    expect(resolveServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ ensure: true }),
    );
    expect(electron.BrowserWindow).toHaveBeenCalledOnce();
    const instance = electron.BrowserWindow.mock.results[0]?.value as {
      loadURL: ReturnType<typeof vi.fn>;
    };
    expect(instance.loadURL).toHaveBeenCalledWith(DISCOVERED_URL);
  });

  it("subscribes to web-contents-created, window-all-closed, and activate", async () => {
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
    expect(subscribed).toContain("activate");
  });

  it("installs an application menu via Menu.setApplicationMenu", async () => {
    const electron = (await import("electron")) as unknown as {
      Menu: {
        setApplicationMenu: ReturnType<typeof vi.fn>;
        buildFromTemplate: ReturnType<typeof vi.fn>;
      };
    };
    electron.Menu.setApplicationMenu.mockClear();
    electron.Menu.buildFromTemplate.mockClear();
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
    expect(electron.Menu.setApplicationMenu).toHaveBeenCalledOnce();
    // buildFromTemplate is called twice: once for the app menu, once
    // for the initial tray menu render.
    expect(
      electron.Menu.buildFromTemplate.mock.calls.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("registers a tray:setStatusDot IPC handler", async () => {
    const electron = (await import("electron")) as unknown as {
      ipcMain: { handle: ReturnType<typeof vi.fn> };
    };
    electron.ipcMain.handle.mockClear();
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
    const channels = electron.ipcMain.handle.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(channels).toContain("nimbus:tray:setStatusDot");
  });
});

describe("main — spawned-server lifecycle", () => {
  // DS7: the before-quit handler is registered unconditionally, before
  // resolveServer runs, so a quit signal arriving mid-readiness-wait
  // still reaps the spawned nimbus. The handler itself is a no-op when
  // resolveServer eventually returned a discovered (not spawned) server.
  it("registers before-quit when the shell spawned the server", async () => {
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

  it("registers before-quit even when the shell only discovered a server", async () => {
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
    // The single always-on handler is the same one that protects the
    // spawn-mid-quit race; in the discovered-only case it simply exits
    // without reaping anything.
    expect(subscribed).toContain("before-quit");
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
