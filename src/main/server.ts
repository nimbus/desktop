import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  type PidChecker,
  pidIsLive,
  readLiveServerDiscovery,
  type ServerDiscoveryRecord,
} from "./discovery.js";
import {
  type LocalServerPaths,
  resolveLocalServerPathsForCurrentPlatform,
} from "./paths.js";

// DS2 contract: the shell discovers a running `nimbus start` or
// spawns a fresh one, then `loadURL`s the renderer at the resolved
// HTTP address. Mirrors crates/nimbus-bin/src/ui.rs `run_ui_command`
// for the discovery + spawn + readiness-probe loop, but is owned by
// the desktop shell rather than the CLI binary.

export const DEFAULT_POLL_INTERVAL_MS = 200;
export const DEFAULT_READINESS_TIMEOUT_MS = 60_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

const UNIX_FALLBACK_BIN_PATHS = [
  "/usr/local/bin/nimbus",
  "/opt/nimbus/bin/nimbus",
] as const;

const UNIX_HOME_FALLBACK_SEGMENTS = [
  [".local", "bin", "nimbus"],
  [".nimbus", "bin", "nimbus"],
] as const;

const WINDOWS_FALLBACK_SEGMENTS = ["nimbus", "bin", "nimbus.exe"] as const;

export interface ServerEnvelope {
  readonly record: ServerDiscoveryRecord;
  readonly url: string;
  readonly origin: "discovered" | "spawned";
  readonly spawned: SpawnedServerHandle | null;
}

export interface SpawnedServerHandle {
  readonly pid: number;
  readonly child: ChildProcess;
}

export interface ResolveServerOptions {
  readonly ensure: boolean;
  readonly paths?: LocalServerPaths;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly pidChecker?: PidChecker;
  readonly probe?: (url: string) => Promise<boolean>;
  readonly nimbusExecutable?: string;
  readonly pollIntervalMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class ServerNotRunningError extends Error {
  constructor() {
    super(
      "Nimbus server is not running. Start one with `nimbus start` (in another terminal) or relaunch the shell with `ensure: true` to spawn one.",
    );
    this.name = "ServerNotRunningError";
  }
}

export class ServerReadinessTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(
      `Timed out after ${timeoutMs} ms waiting for Nimbus server to become ready after spawning it.`,
    );
    this.name = "ServerReadinessTimeoutError";
  }
}

export class NimbusBinaryNotFoundError extends Error {
  constructor(readonly searched: readonly string[]) {
    super(
      `Could not find a \`nimbus\` binary on PATH or at any canonical install path. Looked at: ${searched.join(", ")}. Install via the script at https://github.com/nimbus/nimbus#install.`,
    );
    this.name = "NimbusBinaryNotFoundError";
  }
}

export function normalizeLoopbackAddress(address: string): string {
  for (const prefix of ["[::1]:", "[::]:", "::"] as const) {
    if (address.startsWith(prefix)) {
      return `127.0.0.1:${address.slice(prefix.length)}`;
    }
  }
  const lastColon = address.lastIndexOf(":");
  if (lastColon < 0) return address;
  const host = address.slice(0, lastColon);
  const port = address.slice(lastColon + 1);
  if (host === "0.0.0.0" || host === "") {
    return `127.0.0.1:${port}`;
  }
  return address;
}

export function buildUiUrl(record: ServerDiscoveryRecord): string {
  return `http://${normalizeLoopbackAddress(record.address)}/ui/`;
}

export async function resolveServer(
  options: ResolveServerOptions,
): Promise<ServerEnvelope> {
  const paths = options.paths ?? resolveLocalServerPathsForCurrentPlatform();
  const pidChecker = options.pidChecker ?? pidIsLive;
  const probe = options.probe ?? defaultProbe;
  const env = options.env ?? process.env;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const readinessTimeoutMs =
    options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  const existing = await readLiveServerDiscovery(paths, pidChecker);
  if (existing) {
    return {
      record: existing,
      url: buildUiUrl(existing),
      origin: "discovered",
      spawned: null,
    };
  }

  if (!options.ensure) {
    throw new ServerNotRunningError();
  }

  const executable =
    options.nimbusExecutable ?? (await resolveNimbusExecutable(env));
  const handle = spawnDetached(executable);

  const deadline = now() + readinessTimeoutMs;
  while (now() < deadline) {
    const record = await readLiveServerDiscovery(paths, pidChecker);
    if (record) {
      const url = buildUiUrl(record);
      if (await probe(url)) {
        return { record, url, origin: "spawned", spawned: handle };
      }
    }
    await sleep(pollIntervalMs);
  }
  throw new ServerReadinessTimeoutError(readinessTimeoutMs);
}

async function defaultProbe(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}auth`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    // The server replies 200 for /ui/auth (auth page) or 307 if the
    // user is already authenticated and gets redirected into the
    // app shell. Either is a "ready" signal.
    return (
      response.status >= 200 && response.status < 400 && response.status !== 304
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnDetached(executable: string): SpawnedServerHandle {
  const child = spawn(executable, ["start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  if (typeof child.pid !== "number") {
    throw new Error(`spawn(${executable}) did not return a pid`);
  }
  return { pid: child.pid, child };
}

export async function resolveNimbusExecutable(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const fromPath = await findOnPath("nimbus", env);
  if (fromPath) return fromPath;

  const candidates: string[] = [];
  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(path.join(localAppData, ...WINDOWS_FALLBACK_SEGMENTS));
    }
  } else {
    candidates.push(...UNIX_FALLBACK_BIN_PATHS);
    const home = env.HOME;
    if (home) {
      for (const segments of UNIX_HOME_FALLBACK_SEGMENTS) {
        candidates.push(path.join(home, ...segments));
      }
    }
  }

  for (const candidate of candidates) {
    if (await canExecute(candidate)) return candidate;
  }
  throw new NimbusBinaryNotFoundError(["nimbus (on PATH)", ...candidates]);
}

async function findOnPath(
  binary: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  const pathVar = env.PATH ?? env.Path ?? env.path;
  if (!pathVar) return null;
  const separator = process.platform === "win32" ? ";" : ":";
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT?.split(";") ?? [".EXE", ".CMD", ".BAT"])
      : [""];
  for (const dir of pathVar.split(separator)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, `${binary}${ext}`);
      if (await canExecute(candidate)) return candidate;
    }
  }
  return null;
}

async function canExecute(filePath: string): Promise<boolean> {
  try {
    await fs.access(
      filePath,
      // 1 = X_OK (executable bit). Using the literal avoids importing
      // the `constants` namespace just for one value.
      1,
    );
    return true;
  } catch {
    return false;
  }
}
