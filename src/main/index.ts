import { app, dialog } from "electron";

import { installSecurityRestrictions } from "./security.js";
import {
  NimbusBinaryNotFoundError,
  resolveServer,
  type ServerEnvelope,
  ServerNotRunningError,
  ServerReadinessTimeoutError,
} from "./server.js";
import { createMainWindow, defaultPreloadPath } from "./window.js";

const ALLOWED_ORIGIN_FALLBACK = "http://127.0.0.1/";
const SHUTDOWN_GRACE_MS = 5_000;

export async function main(): Promise<void> {
  await app.whenReady();

  let envelope: ServerEnvelope;
  try {
    envelope = await resolveServer({ ensure: true });
  } catch (error) {
    presentFatalError(error);
    app.quit();
    return;
  }

  installSecurityRestrictions(app, {
    allowedOrigin: originOf(envelope.url, ALLOWED_ORIGIN_FALLBACK),
  });
  createMainWindow({
    url: envelope.url,
    preloadPath: defaultPreloadPath(),
  });

  if (envelope.spawned) {
    const handle = envelope.spawned;
    const serverUrl = envelope.url;
    app.on("before-quit", (event) => {
      event.preventDefault();
      void shutdownSpawnedServer(serverUrl, handle.pid, handle.child).finally(
        () => app.exit(0),
      );
    });
  }

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

function originOf(serverUrl: string, fallback: string): string {
  try {
    const parsed = new URL(serverUrl);
    return `${parsed.protocol}//${parsed.host}/`;
  } catch {
    return fallback;
  }
}

function presentFatalError(error: unknown): void {
  const message =
    error instanceof ServerNotRunningError ||
    error instanceof ServerReadinessTimeoutError ||
    error instanceof NimbusBinaryNotFoundError
      ? error.message
      : `Unexpected error: ${String(error)}`;
  // dialog.showErrorBox is synchronous and safe to call after
  // app.whenReady. If the test harness mocks the dialog module to a
  // no-op, the message still surfaces via the thrown error.
  dialog.showErrorBox?.("Nimbus could not start", message);
}

async function shutdownSpawnedServer(
  serverUrl: string,
  pid: number,
  child: { kill: (signal?: NodeJS.Signals | number) => boolean },
): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SHUTDOWN_GRACE_MS);
    try {
      await fetch(`${serverUrl}api/system/shutdown`, {
        method: "POST",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Fall through to SIGTERM. The server may already be down, or
    // the shutdown endpoint may be unreachable — kill the child as
    // a guaranteed stop signal.
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // best-effort: pid may already be gone
  }
  // Give the process a beat to exit gracefully before exit().
  await sleep(250);
  // If still alive, escalate.
  try {
    process.kill(pid, 0);
    child.kill("SIGKILL");
  } catch {
    // process is gone — exactly what we wanted
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isUnderTest =
  process.env.VITEST !== undefined ||
  process.env.NIMBUS_DESKTOP_SKIP_AUTORUN === "1";

if (!isUnderTest) {
  void main();
}
