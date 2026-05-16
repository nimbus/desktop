import type { MenuItemConstructorOptions } from "electron";

// DS4 contract: native menu bar matching operator-console conventions.
// macOS gets [App, File, Edit, View, Help] = 5 top-level menus. Windows
// and Linux get [File, Edit, View, Help] = 4. The Window submenu is
// macOS-only behavior; on Windows/Linux the platform's native window
// management already handles minimize/zoom/close, so a separate Window
// menu would just shadow OS-level controls.

export type MenuPlatform = "darwin" | "win32" | "linux";

export interface MenuHandlers {
  readonly onOpenConsole: () => void;
  readonly onAbout: () => void;
  readonly onQuit: () => void;
}

export function buildAppMenu(
  platform: MenuPlatform,
  handlers: MenuHandlers,
): MenuItemConstructorOptions[] {
  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      { label: "Open Console", click: () => handlers.onOpenConsole() },
      { type: "separator" },
      platform === "darwin"
        ? { role: "close" }
        : { label: "Quit", click: () => handlers.onQuit() },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: "Help",
    submenu: [{ label: "About Nimbus", click: () => handlers.onAbout() }],
  };

  if (platform === "darwin") {
    const appMenu: MenuItemConstructorOptions = {
      label: "Nimbus",
      submenu: [
        { label: "About Nimbus", click: () => handlers.onAbout() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: "Quit Nimbus", click: () => handlers.onQuit() },
      ],
    };
    return [appMenu, fileMenu, editMenu, viewMenu, helpMenu];
  }

  return [fileMenu, editMenu, viewMenu, helpMenu];
}
