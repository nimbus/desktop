import type { Menu, MenuItemConstructorOptions, Tray } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  createTrayController,
  isTrayStatus,
  type TrayHandlers,
} from "./tray.js";

interface CapturedTray {
  setToolTip: (s: string) => void;
  setContextMenu: (menu: Menu) => void;
  destroy: () => void;
  toolTip: string | null;
  templates: MenuItemConstructorOptions[][];
}

function buildFakeTray(): { tray: Tray; captured: CapturedTray } {
  const captured: CapturedTray = {
    setToolTip: vi.fn(),
    setContextMenu: vi.fn(),
    destroy: vi.fn(),
    toolTip: null,
    templates: [],
  };
  const tray = {
    setToolTip: (s: string) => {
      captured.toolTip = s;
      (captured.setToolTip as unknown as (s: string) => void)(s);
    },
    setContextMenu: (menu: Menu) => {
      (captured.setContextMenu as unknown as (m: Menu) => void)(menu);
    },
    destroy: () => {
      (captured.destroy as unknown as () => void)();
    },
  } as unknown as Tray;
  return { tray, captured };
}

function fakeHandlers(): TrayHandlers {
  return {
    onOpenConsole: vi.fn(),
    onStartServer: vi.fn(),
    onStopServer: vi.fn(),
    onRestartServer: vi.fn(),
    onQuit: vi.fn(),
  };
}

describe("isTrayStatus", () => {
  it("accepts the three documented states", () => {
    expect(isTrayStatus("connected")).toBe(true);
    expect(isTrayStatus("reconnecting")).toBe(true);
    expect(isTrayStatus("offline")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isTrayStatus("ready")).toBe(false);
    expect(isTrayStatus(null)).toBe(false);
    expect(isTrayStatus(undefined)).toBe(false);
    expect(isTrayStatus(1)).toBe(false);
  });
});

describe("createTrayController", () => {
  it("creates a tray with the supplied icon path and tooltip", () => {
    const { tray, captured } = buildFakeTray();
    const trayFactory = vi.fn().mockReturnValue(tray);
    const menuFactory = vi.fn().mockReturnValue({} as Menu);
    createTrayController({
      iconPath: "/tmp/icon.png",
      handlers: fakeHandlers(),
      trayFactory,
      menuFactory,
    });
    expect(trayFactory).toHaveBeenCalledWith("/tmp/icon.png");
    expect(captured.toolTip).toBe("Nimbus");
  });

  it("renders a menu with the documented items in DS4 order", () => {
    const { tray } = buildFakeTray();
    const menuFactory = vi.fn().mockReturnValue({} as Menu);
    createTrayController({
      iconPath: "/tmp/icon.png",
      handlers: fakeHandlers(),
      trayFactory: () => tray,
      menuFactory,
    });
    expect(menuFactory).toHaveBeenCalledOnce();
    const template = menuFactory.mock.calls[0]?.[0] as
      | MenuItemConstructorOptions[]
      | undefined;
    expect(template).toBeDefined();
    const labels = (template ?? [])
      .map((item) => item.label ?? item.type)
      .filter(Boolean);
    expect(labels).toEqual([
      "Open Console",
      "separator",
      "Status: Offline",
      "separator",
      "Start Server",
      "Stop Server",
      "Restart Server",
      "separator",
      "Quit Nimbus",
    ]);
  });

  it("Open Console wires the supplied handler", () => {
    const { tray } = buildFakeTray();
    const menuFactory = vi.fn().mockReturnValue({} as Menu);
    const handlers = fakeHandlers();
    createTrayController({
      iconPath: "/tmp/icon.png",
      handlers,
      trayFactory: () => tray,
      menuFactory,
    });
    const template = menuFactory.mock.calls[0]?.[0] as
      | MenuItemConstructorOptions[]
      | undefined;
    const open = template?.find((item) => item.label === "Open Console") as
      | { click?: () => void }
      | undefined;
    open?.click?.();
    expect(handlers.onOpenConsole).toHaveBeenCalledOnce();
  });

  it("Quit Nimbus wires the supplied handler", () => {
    const { tray } = buildFakeTray();
    const menuFactory = vi.fn().mockReturnValue({} as Menu);
    const handlers = fakeHandlers();
    createTrayController({
      iconPath: "/tmp/icon.png",
      handlers,
      trayFactory: () => tray,
      menuFactory,
    });
    const template = menuFactory.mock.calls[0]?.[0] as
      | MenuItemConstructorOptions[]
      | undefined;
    const quit = template?.find((item) => item.label === "Quit Nimbus") as
      | { click?: () => void }
      | undefined;
    quit?.click?.();
    expect(handlers.onQuit).toHaveBeenCalledOnce();
  });

  it("setStatus re-renders the menu with the new status label", () => {
    const { tray } = buildFakeTray();
    const menuFactory = vi.fn().mockReturnValue({} as Menu);
    const controller = createTrayController({
      iconPath: "/tmp/icon.png",
      handlers: fakeHandlers(),
      trayFactory: () => tray,
      menuFactory,
      initialStatus: "offline",
    });
    controller.setStatus("connected");
    expect(menuFactory).toHaveBeenCalledTimes(2);
    const second = menuFactory.mock.calls[1]?.[0] as
      | MenuItemConstructorOptions[]
      | undefined;
    const status = second?.find(
      (item) =>
        typeof item.label === "string" && item.label.startsWith("Status:"),
    );
    expect(status?.label).toBe("Status: Connected");
  });

  it("setStatus is a no-op when the status does not change", () => {
    const { tray } = buildFakeTray();
    const menuFactory = vi.fn().mockReturnValue({} as Menu);
    const controller = createTrayController({
      iconPath: "/tmp/icon.png",
      handlers: fakeHandlers(),
      trayFactory: () => tray,
      menuFactory,
      initialStatus: "connected",
    });
    controller.setStatus("connected");
    expect(menuFactory).toHaveBeenCalledTimes(1);
  });

  it("destroy delegates to tray.destroy()", () => {
    const { tray, captured } = buildFakeTray();
    const controller = createTrayController({
      iconPath: "/tmp/icon.png",
      handlers: fakeHandlers(),
      trayFactory: () => tray,
      menuFactory: vi.fn().mockReturnValue({} as Menu),
    });
    controller.destroy();
    expect(captured.destroy).toHaveBeenCalledOnce();
  });
});
