import { promises as fs } from "node:fs";
import path from "node:path";

import type { StalenessInfo } from "../../shared/ipc-types.js";

// UL3: main-process staleness notifier.
//
// Polls `/api/system/version-info` on the same nimbus server the
// desktop loaded the UI from. On the *first* observed
// `available: true` transition for a given `latest`, fires an
// Electron `Notification` and persists the version to a small JSON
// file under userData so a relaunch does not re-notify.
//
// Mirrors the renderer-side `useStaleness` hook in
// `packages/nimbus-ui/src/hooks/use-staleness.ts` but lives in the
// main process so the notification fires even when the window is
// minimized / focus is elsewhere.

const DEFAULT_POLL_MS = 5 * 60 * 1000;
const NOTIFIED_FILE_NAME = "notified-versions.json";

export interface NotificationLike {
  show(): void;
  on(event: "click", listener: () => void): unknown;
}

export interface NotificationConstructor {
  new (options: {
    readonly title: string;
    readonly body: string;
    readonly silent?: boolean;
  }): NotificationLike;
}

export interface StalenessNotifierDeps {
  readonly serverUrl: string;
  readonly userDataDir: string;
  readonly fetchFn?: typeof fetch;
  readonly Notification?: NotificationConstructor | null;
  readonly onClick?: () => void;
  readonly pollMs?: number;
  readonly logger?: (message: string) => void;
  // Optional fan-out to the renderer (`window.nimbus.onStaleness`).
  readonly onStaleness?: (info: StalenessInfo) => void;
}

export interface StalenessNotifier {
  start(): void;
  stop(): void;
  // For tests: trigger a single poll synchronously.
  pollOnce(): Promise<void>;
}

interface NotifiedFile {
  readonly versions: readonly string[];
}

export async function readNotifiedFile(
  userDataDir: string,
): Promise<Set<string>> {
  const filePath = path.join(userDataDir, NOTIFIED_FILE_NAME);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as NotifiedFile;
    if (Array.isArray(parsed.versions)) {
      return new Set(
        parsed.versions.filter((v): v is string => typeof v === "string"),
      );
    }
    return new Set();
  } catch {
    return new Set();
  }
}

export async function writeNotifiedFile(
  userDataDir: string,
  versions: Set<string>,
): Promise<void> {
  const filePath = path.join(userDataDir, NOTIFIED_FILE_NAME);
  await fs.mkdir(userDataDir, { recursive: true });
  const payload: NotifiedFile = { versions: [...versions].sort() };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

export function createStalenessNotifier(
  deps: StalenessNotifierDeps,
): StalenessNotifier {
  const fetchFn = deps.fetchFn ?? fetch;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const log = deps.logger ?? (() => {});

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let notified: Set<string> | null = null;

  async function loadNotified(): Promise<Set<string>> {
    if (notified) return notified;
    notified = await readNotifiedFile(deps.userDataDir);
    return notified;
  }

  async function pollOnce(): Promise<void> {
    let info: StalenessInfo | null = null;
    try {
      const res = await fetchFn(`${deps.serverUrl}api/system/version-info`, {
        method: "GET",
      });
      if (!res.ok) {
        log(`staleness poll: ${res.status}`);
        return;
      }
      info = (await res.json()) as StalenessInfo;
    } catch (err) {
      log(`staleness poll failed: ${(err as Error).message}`);
      return;
    }
    if (!info) return;
    deps.onStaleness?.(info);
    if (!info.available || !info.latest) return;
    const latest = info.latest;
    const seen = await loadNotified();
    if (seen.has(latest)) return;
    if (deps.Notification) {
      try {
        const notification = new deps.Notification({
          title: `Nimbus ${latest} available`,
          body: `Open the console to update from ${info.current}.`,
        });
        if (deps.onClick) {
          notification.on("click", deps.onClick);
        }
        notification.show();
      } catch (err) {
        log(`staleness notification failed: ${(err as Error).message}`);
        // Persist the version anyway — we do not want to retry a failing
        // notification on every poll. The renderer toast still covers
        // user attention.
      }
    }
    seen.add(latest);
    notified = seen;
    try {
      await writeNotifiedFile(deps.userDataDir, seen);
    } catch (err) {
      log(`staleness persistence failed: ${(err as Error).message}`);
    }
  }

  function scheduleNext(): void {
    if (!running) return;
    timer = setTimeout(() => {
      void pollOnce().finally(() => {
        scheduleNext();
      });
    }, pollMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      void pollOnce().finally(() => {
        scheduleNext();
      });
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    pollOnce,
  };
}
