import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { findPackagedShell } from "./helpers/find-shell.js";
import {
  launchPackagedShell,
  type ShellHandle,
} from "./helpers/launch-shell.js";
import { resolveTestNimbusBinary } from "./helpers/nimbus-binary.js";
import { createScratchEnv, disposeScratchEnv } from "./helpers/scratch-env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// DS7 lifecycle. Three contracts:
//   1. Spawn-path: shell launched with NO pre-running server must
//      itself spawn `nimbus start`, which then writes the canonical
//      discovery JSON; the shell renderer eventually reaches /ui/.
//   2. Shutdown: quitting the shell must reap the spawned nimbus,
//      not leave it as an orphan.
//   3. Relaunch: a second launch against the same scratch state must
//      either discover the still-running server or spawn a fresh one
//      — either way, the renderer reaches /ui/ on the second pass.

interface DiscoveryRecord {
  readonly pid: number;
  readonly address: string;
}

const SPAWN_TIMEOUT_MS = 90_000;
const SHUTDOWN_REAP_TIMEOUT_MS = 10_000;

test.describe("DS7 lifecycle", () => {
  let nimbusBin: string;
  let shellBin: string;

  test.beforeAll(async () => {
    nimbusBin = await resolveTestNimbusBinary(REPO_ROOT);
    shellBin = await findPackagedShell(REPO_ROOT);
  });

  test("spawn-path: shell starts nimbus, renderer reaches /ui/", async () => {
    const scratch = createScratchEnv();
    let shell: ShellHandle | undefined;
    try {
      shell = await launchPackagedShell({
        binary: shellBin,
        scratch,
        nimbusBin,
        readinessTimeoutMs: SPAWN_TIMEOUT_MS,
      });
      // Wait for a discovery file backed by a live nimbus pid —
      // proof the spawned nimbus is up and reachable.
      const discovered = await waitFor(
        () => readLiveDiscovery(scratch.discoveryPath),
        SPAWN_TIMEOUT_MS,
      );
      expect(discovered.pid).toBeGreaterThan(0);
      expect(discovered.address).toMatch(/127\.0\.0\.1:\d+/);
      // Probe the spawned server. Anything in 200-399 (except 304)
      // is the contract `src/main/server.ts::defaultProbe` uses.
      const probe = await fetch(
        `http://${normalizeAddress(discovered.address)}/ui/auth`,
      );
      expect(probe.status).toBeGreaterThanOrEqual(200);
      expect(probe.status).toBeLessThan(400);
    } finally {
      if (shell) await shell.shutdown();
      // After shutdown, the shell should have reaped the spawned
      // nimbus via POST /api/system/shutdown — verify the discovery
      // pid is gone.
      await assertSpawnedNimbusGone(scratch.discoveryPath);
      disposeScratchEnv(scratch);
    }
  });

  test("relaunch reaches /ui/ against the same scratch state", async () => {
    const scratch = createScratchEnv();
    let shell: ShellHandle | undefined;
    try {
      // First launch: spawn-path.
      shell = await launchPackagedShell({
        binary: shellBin,
        scratch,
        nimbusBin,
        readinessTimeoutMs: SPAWN_TIMEOUT_MS,
      });
      await waitFor(
        () => readLiveDiscovery(scratch.discoveryPath),
        SPAWN_TIMEOUT_MS,
      );
      await shell.shutdown();
      await assertSpawnedNimbusGone(scratch.discoveryPath);
      shell = undefined;

      // Second launch: same scratch state. Discovery file may be
      // stale (pid dead) or absent — the shell must either spawn a
      // fresh nimbus or discover whatever is live. Either path ends
      // with a fresh discovery file backed by a live pid, and a
      // /ui/auth probe that 2xx's.
      shell = await launchPackagedShell({
        binary: shellBin,
        scratch,
        nimbusBin,
        readinessTimeoutMs: SPAWN_TIMEOUT_MS,
      });
      const discovered = await waitFor(
        () => readLiveDiscovery(scratch.discoveryPath),
        SPAWN_TIMEOUT_MS,
      );
      const probe = await fetch(
        `http://${normalizeAddress(discovered.address)}/ui/auth`,
      );
      expect(probe.status).toBeGreaterThanOrEqual(200);
      expect(probe.status).toBeLessThan(400);
    } finally {
      if (shell) await shell.shutdown();
      await assertSpawnedNimbusGone(scratch.discoveryPath);
      disposeScratchEnv(scratch);
    }
  });
});

function readDiscovery(p: string): DiscoveryRecord | null {
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, "utf8").trim();
    if (raw.length === 0) return null;
    const parsed = JSON.parse(raw) as Partial<DiscoveryRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.address !== "string") {
      return null;
    }
    return { pid: parsed.pid, address: parsed.address };
  } catch {
    return null;
  }
}

// The shell's resolveServer checks pid liveness before honouring an
// existing discovery file, but tests reading the file directly need
// to enforce the same invariant — otherwise the relaunch path races
// the new nimbus's overwrite and snapshots a stale record from the
// previous sub-launch.
function readLiveDiscovery(p: string): DiscoveryRecord | null {
  const record = readDiscovery(p);
  if (!record) return null;
  try {
    process.kill(record.pid, 0);
    return record;
  } catch {
    return null;
  }
}

async function waitFor<T>(
  produce: () => T | null | Promise<T | null>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await produce();
    if (value !== null && value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for predicate`);
}

function normalizeAddress(address: string): string {
  if (address.startsWith("0.0.0.0:")) {
    return `127.0.0.1:${address.slice("0.0.0.0:".length)}`;
  }
  if (address.startsWith("[::]:")) {
    return `127.0.0.1:${address.slice("[::]:".length)}`;
  }
  if (address.startsWith("[::1]:")) {
    return `127.0.0.1:${address.slice("[::1]:".length)}`;
  }
  return address;
}

async function assertSpawnedNimbusGone(discoveryPath: string): Promise<void> {
  const record = readDiscovery(discoveryPath);
  if (!record) return; // file was removed on shutdown — ideal
  // The discovery file may be left behind by a forcibly-killed
  // server; what matters is that the pid no longer exists.
  const deadline = Date.now() + SHUTDOWN_REAP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(record.pid, 0);
      // still alive — wait
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      return; // process gone — what we wanted
    }
  }
  throw new Error(
    `spawned nimbus pid=${record.pid} was not reaped within ${SHUTDOWN_REAP_TIMEOUT_MS}ms`,
  );
}
