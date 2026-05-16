import {
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  Tray,
} from "electron";

// DS4 contract: tray icon with a status dot label sourced via the
// renderer→main `tray:setStatusDot` IPC channel. The tray menu offers
// Open Console, Server status (read-only), Start/Stop/Restart server,
// and Quit. The icon itself is a single template image; the status is
// reflected in the menu's "Server status" item label, which is the
// pattern other operator consoles (Docker Desktop, 1Password) use.

export type TrayStatus = "connected" | "reconnecting" | "offline";

export interface TrayHandlers {
  readonly onOpenConsole: () => void;
  readonly onStartServer: () => void | Promise<void>;
  readonly onStopServer: () => void | Promise<void>;
  readonly onRestartServer: () => void | Promise<void>;
  readonly onQuit: () => void;
}

export interface TrayController {
  setStatus(status: TrayStatus): void;
  destroy(): void;
}

const STATUS_LABEL: Readonly<Record<TrayStatus, string>> = {
  connected: "Status: Connected",
  reconnecting: "Status: Reconnecting",
  offline: "Status: Offline",
};

export function isTrayStatus(value: unknown): value is TrayStatus {
  return (
    typeof value === "string" &&
    (value === "connected" || value === "reconnecting" || value === "offline")
  );
}

export interface CreateTrayOptions {
  readonly iconPath: string;
  readonly handlers: TrayHandlers;
  readonly initialStatus?: TrayStatus;
  // Injected for tests so we can supply a fake Tray/Menu factory.
  readonly trayFactory?: (iconPath: string) => Tray;
  readonly menuFactory?: (template: MenuItemConstructorOptions[]) => Menu;
}

export function createTrayController(opts: CreateTrayOptions): TrayController {
  const trayFactory =
    opts.trayFactory ??
    ((iconPath: string) => new Tray(nativeImage.createFromPath(iconPath)));
  const menuFactory =
    opts.menuFactory ??
    ((template: MenuItemConstructorOptions[]) =>
      Menu.buildFromTemplate(template));

  const tray = trayFactory(opts.iconPath);
  tray.setToolTip("Nimbus");

  let status: TrayStatus = opts.initialStatus ?? "offline";

  const render = (): void => {
    const template: MenuItemConstructorOptions[] = [
      { label: "Open Console", click: () => opts.handlers.onOpenConsole() },
      { type: "separator" },
      { label: STATUS_LABEL[status], enabled: false },
      { type: "separator" },
      {
        label: "Start Server",
        click: () => void opts.handlers.onStartServer(),
      },
      { label: "Stop Server", click: () => void opts.handlers.onStopServer() },
      {
        label: "Restart Server",
        click: () => void opts.handlers.onRestartServer(),
      },
      { type: "separator" },
      { label: "Quit Nimbus", click: () => opts.handlers.onQuit() },
    ];
    tray.setContextMenu(menuFactory(template));
  };

  render();

  return {
    setStatus(next: TrayStatus): void {
      if (next === status) return;
      status = next;
      render();
    },
    destroy(): void {
      tray.destroy();
    },
  };
}
