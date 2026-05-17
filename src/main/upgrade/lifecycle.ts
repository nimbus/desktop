import type { ChildProcess } from "node:child_process";

import type {
  InstallMethod,
  RunnerEvent,
  RunnerEventEnvelope,
  UpgradeMethod,
} from "../../shared/ipc-types.js";
import { NIMBUS_RUNNER_EVENT_CHANNEL } from "../../shared/ipc-types.js";
import type { SpawnedServerHandle } from "../server.js";
import { type UpgradeRunner } from "./runner.js";

// UL3: wraps the upgrade runner so the IPC layer can route a typed
// invoke + per-call envelope stream into the renderer. Holds the
// post-upgrade restart sequence as an injected dep so the main
// process can wire it once at startup (where it already owns the
// nimbus child) rather than the runner reaching into the lifecycle.

export interface RestartedResult {
  readonly newVersion: string;
  readonly handle: SpawnedServerHandle;
  readonly url: string;
}

export interface UpgradeLifecycleDeps {
  readonly runner: UpgradeRunner;
  readonly emit: (channel: string, payload: RunnerEventEnvelope) => void;
  readonly restartNimbus: () => Promise<RestartedResult>;
  // Optional pre-restart hook (e.g., to SIGTERM the previous child).
  readonly shutdownPrevious?: (
    child: ChildProcess | null,
    pid: number | null,
    url: string | null,
  ) => Promise<void>;
  readonly logger?: (message: string) => void;
}

export interface UpgradeLifecycle {
  startUpgrade(payload: {
    subscriptionId: string;
    method: UpgradeMethod;
  }): { ok: true } | { ok: false; error: string };
  startInstall(payload: {
    subscriptionId: string;
    method: InstallMethod;
  }): { ok: true } | { ok: false; error: string };
}

export function createUpgradeLifecycle(
  deps: UpgradeLifecycleDeps,
): UpgradeLifecycle {
  const log = deps.logger ?? (() => {});

  function pumpEvents(
    subscriptionId: string,
    iterable: AsyncIterable<RunnerEvent>,
  ): void {
    void (async () => {
      try {
        for await (const event of iterable) {
          const envelope: RunnerEventEnvelope = { subscriptionId, event };
          try {
            deps.emit(NIMBUS_RUNNER_EVENT_CHANNEL, envelope);
          } catch (err) {
            log(`runner emit failed: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        const envelope: RunnerEventEnvelope = {
          subscriptionId,
          event: {
            kind: "error",
            message: `Runner iteration failed: ${(err as Error).message}`,
            fallback: "copy",
          },
        };
        try {
          deps.emit(NIMBUS_RUNNER_EVENT_CHANNEL, envelope);
        } catch {}
      }
    })();
  }

  return {
    startUpgrade(payload) {
      if (
        !payload ||
        typeof payload.subscriptionId !== "string" ||
        typeof payload.method !== "string"
      ) {
        return { ok: false, error: "invalid subscription payload" };
      }
      pumpEvents(
        payload.subscriptionId,
        deps.runner.runUpgrade(payload.method),
      );
      return { ok: true };
    },
    startInstall(payload) {
      if (
        !payload ||
        typeof payload.subscriptionId !== "string" ||
        typeof payload.method !== "string"
      ) {
        return { ok: false, error: "invalid subscription payload" };
      }
      pumpEvents(
        payload.subscriptionId,
        deps.runner.runInstall(payload.method),
      );
      return { ok: true };
    },
  };
}
