import type { App, Event, WebContents } from "electron";

export interface SecurityOptions {
  readonly allowedOrigin: string;
}

// Permissions the renderer is allowed to request. The Nimbus
// operator console's `CopyChip` uses clipboard read/write; nothing
// else is granted. See Control Plan Rule 7 in
// docs/plans/desktop-shell-plan.md (Phase 2).
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-read",
  "clipboard-sanitized-write",
]);

export function isAllowedOrigin(url: string, allowed: string): boolean {
  try {
    return new URL(url).origin === new URL(allowed).origin;
  } catch {
    return false;
  }
}

export function applyToWebContents(
  contents: WebContents,
  opts: SecurityOptions,
): void {
  contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });

  contents.on("will-navigate", (event: Event, url: string) => {
    if (!isAllowedOrigin(url, opts.allowedOrigin)) {
      event.preventDefault();
    }
  });

  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}

export function installSecurityRestrictions(
  app: App,
  opts: SecurityOptions,
): void {
  app.on("web-contents-created", (_event, contents) => {
    applyToWebContents(contents, opts);
  });
}
