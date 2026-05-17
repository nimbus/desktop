import { describe, expect, it, vi } from "vitest";

import type {
  InstallMethod,
  RunnerEvent,
  RunnerEventEnvelope,
  UpgradeMethod,
} from "../../shared/ipc-types.js";
import { createUpgradeLifecycle } from "./lifecycle.js";
import type { UpgradeRunner } from "./runner.js";

function makeRunner(): {
  runner: UpgradeRunner;
  upgradeCalls: UpgradeMethod[];
  installCalls: InstallMethod[];
  emitUpgrade: (event: RunnerEvent) => void;
  endUpgrade: () => void;
} {
  const upgradeCalls: UpgradeMethod[] = [];
  const installCalls: InstallMethod[] = [];
  const queue: RunnerEvent[] = [];
  let resolveWake: (() => void) | null = null;
  let done = false;
  const wake = () => {
    const r = resolveWake;
    resolveWake = null;
    r?.();
  };
  const runner: UpgradeRunner = {
    async canRunUpgrade() {
      return true;
    },
    async canRunInstall() {
      return true;
    },
    runUpgrade(method) {
      upgradeCalls.push(method);
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<RunnerEvent> {
          while (true) {
            while (queue.length > 0) {
              const next = queue.shift();
              if (next) yield next;
            }
            if (done) return;
            await new Promise<void>((resolve) => {
              resolveWake = resolve;
            });
          }
        },
      };
    },
    runInstall(method) {
      installCalls.push(method);
      return {
        async *[Symbol.asyncIterator]() {
          // empty stream
        },
      };
    },
  };
  return {
    runner,
    upgradeCalls,
    installCalls,
    emitUpgrade: (event) => {
      queue.push(event);
      wake();
    },
    endUpgrade: () => {
      done = true;
      wake();
    },
  };
}

describe("createUpgradeLifecycle", () => {
  it("starts the upgrade runner with the requested method tag", () => {
    const rig = makeRunner();
    const lifecycle = createUpgradeLifecycle({
      runner: rig.runner,
      emit: vi.fn(),
      restartNimbus: vi.fn(),
    });
    const result = lifecycle.startUpgrade({
      subscriptionId: "sub-1",
      method: "brew",
    });
    expect(result).toEqual({ ok: true });
    expect(rig.upgradeCalls).toEqual(["brew"]);
  });

  it("forwards every runner event over the configured emit channel with the subscription id", async () => {
    const rig = makeRunner();
    const emitted: RunnerEventEnvelope[] = [];
    const lifecycle = createUpgradeLifecycle({
      runner: rig.runner,
      emit: (_channel, payload) => emitted.push(payload),
      restartNimbus: vi.fn(),
    });
    lifecycle.startUpgrade({ subscriptionId: "sub-2", method: "brew" });
    rig.emitUpgrade({ kind: "stdout", line: "hello" });
    rig.emitUpgrade({ kind: "exit", code: 0, signal: null });
    rig.endUpgrade();
    // Give the pump a tick to drain
    await new Promise((r) => setImmediate(r));
    expect(emitted.map((e) => e.subscriptionId)).toEqual(["sub-2", "sub-2"]);
    expect(emitted[0]?.event.kind).toBe("stdout");
    expect(emitted[1]?.event.kind).toBe("exit");
  });

  it("rejects payloads missing subscriptionId or method", () => {
    const lifecycle = createUpgradeLifecycle({
      runner: makeRunner().runner,
      emit: vi.fn(),
      restartNimbus: vi.fn(),
    });
    // @ts-expect-error verifying boundary rejection at runtime
    expect(lifecycle.startUpgrade({}).ok).toBe(false);
    expect(
      // @ts-expect-error verifying boundary rejection at runtime
      lifecycle.startUpgrade({ subscriptionId: 5, method: "brew" }).ok,
    ).toBe(false);
  });

  it("startInstall routes to the install runner with the install-method tag", () => {
    const rig = makeRunner();
    const lifecycle = createUpgradeLifecycle({
      runner: rig.runner,
      emit: vi.fn(),
      restartNimbus: vi.fn(),
    });
    const result = lifecycle.startInstall({
      subscriptionId: "sub-3",
      method: "brew",
    });
    expect(result).toEqual({ ok: true });
    expect(rig.installCalls).toEqual(["brew"]);
  });
});
