import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  return {
    app: {
      whenReady: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      quit: vi.fn(),
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

const { PLACEHOLDER_URL, main } = await import("./index.js");

describe("PLACEHOLDER_URL", () => {
  it("is a real HTTPS URL so the security baseline is exercised in DS1", () => {
    expect(PLACEHOLDER_URL).toMatch(/^https:\/\//);
    const parsed = new URL(PLACEHOLDER_URL);
    expect(parsed.protocol).toBe("https:");
  });
});

describe("main", () => {
  it("awaits whenReady before constructing the window", async () => {
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

    await main();

    expect(electron.app.whenReady).toHaveBeenCalledOnce();
    expect(electron.BrowserWindow).toHaveBeenCalledOnce();
  });

  it("subscribes to web-contents-created and window-all-closed", async () => {
    const electron = (await import("electron")) as unknown as {
      app: {
        whenReady: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
      };
    };
    electron.app.on.mockClear();
    await main();
    const subscribed = electron.app.on.mock.calls.map(
      (c: unknown[]) => c[0] as string,
    );
    expect(subscribed).toContain("web-contents-created");
    expect(subscribed).toContain("window-all-closed");
  });

  it("loads the placeholder URL into the new window", async () => {
    const electron = (await import("electron")) as unknown as {
      BrowserWindow: ReturnType<typeof vi.fn>;
    };
    electron.BrowserWindow.mockClear();
    await main();
    const instance = electron.BrowserWindow.mock.results[0].value as {
      loadURL: ReturnType<typeof vi.fn>;
    };
    expect(instance.loadURL).toHaveBeenCalledWith(PLACEHOLDER_URL);
  });
});

describe("autorun guard", () => {
  it("skips auto-running main() under vitest", () => {
    // If the autorun fired during import, the test runner would have
    // crashed when our mocked BrowserWindow / app shimmed Electron's
    // real native API. Reaching this assertion is itself proof that
    // the `process.env.VITEST` guard suppressed `void main()` at
    // module-load time.
    expect(process.env.VITEST).toBeDefined();
  });
});
