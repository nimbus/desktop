import { describe, expect, it, vi } from "vitest";

import { buildAppMenu, type MenuHandlers } from "./menu.js";

function fakeHandlers(): MenuHandlers {
  return {
    onOpenConsole: vi.fn(),
    onAbout: vi.fn(),
    onQuit: vi.fn(),
  };
}

describe("buildAppMenu", () => {
  it("macOS has 5 top-level menus: App, File, Edit, View, Help", () => {
    const menu = buildAppMenu("darwin", fakeHandlers());
    expect(menu).toHaveLength(5);
    expect(menu.map((m) => m.label)).toEqual([
      "Nimbus",
      "File",
      "Edit",
      "View",
      "Help",
    ]);
  });

  it("Windows has 4 top-level menus: File, Edit, View, Help", () => {
    const menu = buildAppMenu("win32", fakeHandlers());
    expect(menu).toHaveLength(4);
    expect(menu.map((m) => m.label)).toEqual(["File", "Edit", "View", "Help"]);
  });

  it("Linux has 4 top-level menus: File, Edit, View, Help", () => {
    const menu = buildAppMenu("linux", fakeHandlers());
    expect(menu).toHaveLength(4);
    expect(menu.map((m) => m.label)).toEqual(["File", "Edit", "View", "Help"]);
  });

  it("macOS App menu Quit invokes the onQuit handler", () => {
    const handlers = fakeHandlers();
    const menu = buildAppMenu("darwin", handlers);
    const appSubmenu = menu[0]?.submenu as ReadonlyArray<{
      label?: string;
      click?: () => void;
    }>;
    const quit = appSubmenu.find((item) => item.label === "Quit Nimbus");
    quit?.click?.();
    expect(handlers.onQuit).toHaveBeenCalledOnce();
  });

  it("Windows File > Quit invokes the onQuit handler", () => {
    const handlers = fakeHandlers();
    const menu = buildAppMenu("win32", handlers);
    const fileSubmenu = menu[0]?.submenu as ReadonlyArray<{
      label?: string;
      click?: () => void;
    }>;
    const quit = fileSubmenu.find((item) => item.label === "Quit");
    quit?.click?.();
    expect(handlers.onQuit).toHaveBeenCalledOnce();
  });

  it("File > Open Console invokes the onOpenConsole handler", () => {
    const handlers = fakeHandlers();
    const menu = buildAppMenu("linux", handlers);
    const fileSubmenu = menu[0]?.submenu as ReadonlyArray<{
      label?: string;
      click?: () => void;
    }>;
    const open = fileSubmenu.find((item) => item.label === "Open Console");
    open?.click?.();
    expect(handlers.onOpenConsole).toHaveBeenCalledOnce();
  });

  it("Help > About Nimbus invokes the onAbout handler", () => {
    const handlers = fakeHandlers();
    const menu = buildAppMenu("linux", handlers);
    const helpSubmenu = menu[3]?.submenu as ReadonlyArray<{
      label?: string;
      click?: () => void;
    }>;
    const about = helpSubmenu.find((item) => item.label === "About Nimbus");
    about?.click?.();
    expect(handlers.onAbout).toHaveBeenCalledOnce();
  });
});
