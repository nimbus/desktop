import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  // `new BrowserWindow(opts)` must be constructable. vitest's `vi.fn`
  // is callable both as `f()` and `new f()` — but the implementation
  // must be a `function` expression (or class), never an arrow
  // function, because arrow functions are not constructors per the
  // ECMAScript spec ([[Construct]] is absent).
  const fakeWebContents = {
    session: { setPermissionRequestHandler: vi.fn() },
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  // biome-ignore lint/complexity/useArrowFunction: needs [[Construct]] for `new BrowserWindow(...)`
  const BrowserWindow = vi.fn().mockImplementation(function (opts: unknown) {
    return {
      opts,
      webContents: fakeWebContents,
      once: vi.fn(),
      on: vi.fn(),
      show: vi.fn(),
      getBounds: vi.fn().mockReturnValue({
        x: 100,
        y: 200,
        width: 1280,
        height: 800,
      }),
      loadURL: vi.fn().mockResolvedValue(undefined),
    };
  });
  return { BrowserWindow };
});

const { buildWebPreferences, createMainWindow, defaultPreloadPath } =
  await import("./window.js");

describe("buildWebPreferences", () => {
  it("pins the four sandbox flags required by the security baseline", () => {
    const prefs = buildWebPreferences("/abs/preload/index.js");
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.preload).toBe("/abs/preload/index.js");
  });
});

describe("defaultPreloadPath", () => {
  it("resolves to a path under preload/index.cjs (CJS preload artifact)", () => {
    const p = defaultPreloadPath();
    // path.join uses the host's separator (`\` on Windows, `/`
    // elsewhere). The contract is "a path ending at
    // <sep>preload<sep>index.cjs" — express it with path.sep so
    // the assertion holds on every CI runner.
    const suffix = `${path.sep}preload${path.sep}index.cjs`;
    expect(p.endsWith(suffix)).toBe(true);
  });
});

describe("createMainWindow", () => {
  it("constructs a BrowserWindow with the security baseline + size budgets", async () => {
    const electron = (await import("electron")) as unknown as {
      BrowserWindow: ReturnType<typeof vi.fn>;
    };
    electron.BrowserWindow.mockClear();
    createMainWindow({
      url: "https://example.org/",
      preloadPath: "/abs/preload/index.js",
    });
    expect(electron.BrowserWindow).toHaveBeenCalledOnce();
    const opts = electron.BrowserWindow.mock.calls[0][0] as {
      width: number;
      height: number;
      minWidth: number;
      minHeight: number;
      show: boolean;
      webPreferences: { sandbox: boolean; preload: string };
    };
    expect(opts.width).toBe(1280);
    expect(opts.height).toBe(800);
    expect(opts.minWidth).toBe(960);
    expect(opts.minHeight).toBe(600);
    expect(opts.show).toBe(false);
    expect(opts.webPreferences.sandbox).toBe(true);
    expect(opts.webPreferences.preload).toBe("/abs/preload/index.js");
  });

  it("calls loadURL with the discovered URL", async () => {
    const electron = (await import("electron")) as unknown as {
      BrowserWindow: ReturnType<typeof vi.fn>;
    };
    electron.BrowserWindow.mockClear();
    createMainWindow({
      url: "http://127.0.0.1:8080/ui/",
      preloadPath: "/abs/preload/index.js",
    });
    const instance = electron.BrowserWindow.mock.results[0].value as {
      loadURL: ReturnType<typeof vi.fn>;
    };
    expect(instance.loadURL).toHaveBeenCalledWith("http://127.0.0.1:8080/ui/");
  });

  it("uses persisted bounds when supplied", async () => {
    const electron = (await import("electron")) as unknown as {
      BrowserWindow: ReturnType<typeof vi.fn>;
    };
    electron.BrowserWindow.mockClear();
    createMainWindow({
      url: "http://127.0.0.1:8080/ui/",
      preloadPath: "/abs/preload/index.js",
      bounds: { x: 50, y: 60, width: 1400, height: 900 },
    });
    const opts = electron.BrowserWindow.mock.calls[0][0] as {
      x: number | undefined;
      y: number | undefined;
      width: number;
      height: number;
    };
    expect(opts.x).toBe(50);
    expect(opts.y).toBe(60);
    expect(opts.width).toBe(1400);
    expect(opts.height).toBe(900);
  });

  it("subscribes resize/move/close to persist bounds when onBoundsChanged is provided", async () => {
    const electron = (await import("electron")) as unknown as {
      BrowserWindow: ReturnType<typeof vi.fn>;
    };
    electron.BrowserWindow.mockClear();
    const onBoundsChanged = vi.fn();
    createMainWindow({
      url: "http://127.0.0.1:8080/ui/",
      preloadPath: "/abs/preload/index.js",
      onBoundsChanged,
    });
    const instance = electron.BrowserWindow.mock.results[0].value as {
      on: ReturnType<typeof vi.fn>;
    };
    const events = instance.on.mock.calls.map((c) => c[0]);
    expect(events).toContain("resize");
    expect(events).toContain("move");
    expect(events).toContain("close");
  });

  it("debounced bounds handler eventually fires with current getBounds()", async () => {
    vi.useFakeTimers();
    try {
      const electron = (await import("electron")) as unknown as {
        BrowserWindow: ReturnType<typeof vi.fn>;
      };
      electron.BrowserWindow.mockClear();
      const onBoundsChanged = vi.fn();
      createMainWindow({
        url: "http://127.0.0.1:8080/ui/",
        preloadPath: "/abs/preload/index.js",
        onBoundsChanged,
      });
      const instance = electron.BrowserWindow.mock.results[0].value as {
        on: ReturnType<typeof vi.fn>;
      };
      const resizeHandler = instance.on.mock.calls.find(
        (c) => c[0] === "resize",
      )?.[1] as () => void;
      resizeHandler();
      resizeHandler();
      vi.advanceTimersByTime(300);
      expect(onBoundsChanged).toHaveBeenCalledOnce();
      expect(onBoundsChanged).toHaveBeenCalledWith({
        x: 100,
        y: 200,
        width: 1280,
        height: 800,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
