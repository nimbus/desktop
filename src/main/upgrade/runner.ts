import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  InstallMethod,
  RunnerEvent,
  UpgradeMethod,
} from "../../shared/ipc-types.js";

// UL3: background upgrade + install runner.
//
// The contract is intentionally narrow:
//   - The renderer hands us a *method tag* (closed union from
//     `ipc-types.ts`). It never hands us a command string or argv
//     array.
//   - We map the tag → an exact hardcoded argv via the tables below,
//     then `spawn(argv[0], argv.slice(1), { shell: false })`.
//   - stdout + stderr are piped, line-split on `\n`, and emitted as
//     `RunnerEvent`s. No PTY. No shell. No Terminal window opens.
//   - We refuse to spawn for tags that require sudo/TTY or are not a
//     package-manager update (apt, dnf, install-script, source,
//     unknown). The SPA falls back to the Copy-command path.
//
// Capability probes (`canRunUpgrade`/`canRunInstall`) answer "yes
// only if I would actually spawn for this tag right now": the tag
// must be in the table AND the binary must be discoverable on the
// sanitized PATH.

const UPGRADE_ARGV: Record<UpgradeMethod, readonly string[] | null> = {
  brew: ["brew", "upgrade", "--cask", "nimbus/tap/nimbus"],
  apt: null,
  dnf: null,
  "install-script": null,
  source: null,
  unknown: null,
};

const INSTALL_ARGV: Record<InstallMethod, readonly string[] | null> = {
  brew: ["brew", "install", "--cask", "nimbus/tap/nimbus"],
  "install-script": null,
  manual: null,
};

const PATH_AUGMENT_DARWIN = ["/opt/homebrew/bin", "/usr/local/bin"];
const PATH_AUGMENT_LINUX = ["/usr/local/bin", "/usr/bin", "/bin"];

export type Platform = NodeJS.Platform;
export type SpawnFn = typeof nodeSpawn;

export interface UpgradeRunnerDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: Platform;
  readonly spawn?: SpawnFn;
  readonly accessExecutable?: (filePath: string) => Promise<boolean>;
  // Hook for the post-upgrade restart sequence. Called once on
  // exit-code-0 for upgrades; resolves with the new version reported
  // by the readiness probe (see src/main/server.ts).
  readonly onUpgradeSucceeded?: () => Promise<{ readonly newVersion: string }>;
}

export interface UpgradeRunner {
  canRunUpgrade(method: UpgradeMethod): Promise<boolean>;
  canRunInstall(method: InstallMethod): Promise<boolean>;
  runUpgrade(method: UpgradeMethod): AsyncIterable<RunnerEvent>;
  runInstall(method: InstallMethod): AsyncIterable<RunnerEvent>;
}

export function buildSanitizedPath(
  platform: Platform,
  existingPath: string | undefined,
): string {
  const augment =
    platform === "darwin"
      ? PATH_AUGMENT_DARWIN
      : platform === "linux"
        ? PATH_AUGMENT_LINUX
        : [];
  const sep = platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const dir of augment) {
    if (!seen.has(dir)) {
      seen.add(dir);
      parts.push(dir);
    }
  }
  if (existingPath) {
    for (const dir of existingPath.split(sep)) {
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      parts.push(dir);
    }
  }
  return parts.join(sep);
}

async function defaultAccessExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, 1);
    return true;
  } catch {
    return false;
  }
}

async function findOnSanitizedPath(
  binary: string,
  sanitizedPath: string,
  platform: Platform,
  access: (filePath: string) => Promise<boolean>,
): Promise<string | null> {
  const sep = platform === "win32" ? ";" : ":";
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  for (const dir of sanitizedPath.split(sep)) {
    if (!dir) continue;
    const candidate = pathApi.join(dir, binary);
    if (await access(candidate)) return candidate;
  }
  return null;
}

export function createUpgradeRunner(
  deps: UpgradeRunnerDeps = {},
): UpgradeRunner {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? (process.platform as Platform);
  const spawn = deps.spawn ?? nodeSpawn;
  const access = deps.accessExecutable ?? defaultAccessExecutable;

  const sanitizedPath = buildSanitizedPath(platform, env.PATH);
  const childEnv: NodeJS.ProcessEnv = { ...env, PATH: sanitizedPath };

  async function probeBinary(argv: readonly string[]): Promise<boolean> {
    const binary = argv[0];
    if (!binary) return false;
    const located = await findOnSanitizedPath(
      binary,
      sanitizedPath,
      platform,
      access,
    );
    return located !== null;
  }

  async function canRunUpgrade(method: UpgradeMethod): Promise<boolean> {
    if (platform === "win32") return false;
    const argv = UPGRADE_ARGV[method];
    if (!argv) return false;
    return probeBinary(argv);
  }

  async function canRunInstall(method: InstallMethod): Promise<boolean> {
    if (platform === "win32") return false;
    const argv = INSTALL_ARGV[method];
    if (!argv) return false;
    return probeBinary(argv);
  }

  async function* runArgv(
    method: UpgradeMethod | InstallMethod,
    argv: readonly string[] | null,
    isUpgrade: boolean,
  ): AsyncIterable<RunnerEvent> {
    if (platform === "win32") {
      yield {
        kind: "error",
        message:
          "Background package-manager runs are not supported on Windows in this version. Copy the command and run it in your own terminal.",
        fallback: "copy",
      };
      return;
    }
    if (!argv) {
      yield {
        kind: "error",
        message: `Background run is not supported for method "${method}". Copy the command and run it in your own terminal.`,
        fallback: "copy",
      };
      return;
    }
    if (!(await probeBinary(argv))) {
      yield {
        kind: "error",
        message: `Required tool "${argv[0]}" was not found on PATH. Install it or copy the command and run it in your own terminal.`,
        fallback: "copy",
      };
      return;
    }

    yield { kind: "started", method, argv };

    const child: ChildProcess = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: childEnv,
      windowsHide: true,
    });

    const queue: RunnerEvent[] = [];
    let resolveWake: (() => void) | null = null;
    let done = false;
    const wake = () => {
      const r = resolveWake;
      resolveWake = null;
      r?.();
    };
    const push = (event: RunnerEvent) => {
      queue.push(event);
      wake();
    };
    const lineSplit = (
      bucket: { partial: string },
      chunk: string,
      kind: "stdout" | "stderr",
    ) => {
      const combined = bucket.partial + chunk;
      const segments = combined.split("\n");
      bucket.partial = segments.pop() ?? "";
      for (const line of segments) {
        push({ kind, line: line.replace(/\r$/, "") });
      }
    };
    const stdoutBucket = { partial: "" };
    const stderrBucket = { partial: "" };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      lineSplit(stdoutBucket, chunk, "stdout");
    });
    child.stderr?.on("data", (chunk: string) => {
      lineSplit(stderrBucket, chunk, "stderr");
    });
    child.on("error", (err) => {
      push({
        kind: "error",
        message: `Failed to spawn ${argv[0]}: ${err.message}`,
        fallback: "copy",
      });
      done = true;
      wake();
    });
    child.on("exit", (code, signal) => {
      if (stdoutBucket.partial.length > 0) {
        push({ kind: "stdout", line: stdoutBucket.partial });
        stdoutBucket.partial = "";
      }
      if (stderrBucket.partial.length > 0) {
        push({ kind: "stderr", line: stderrBucket.partial });
        stderrBucket.partial = "";
      }
      push({ kind: "exit", code: code ?? -1, signal });
      done = true;
      wake();
    });

    let cleanExit = false;
    while (true) {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) continue;
        if (next.kind === "exit" && next.code === 0) {
          cleanExit = true;
        }
        yield next;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        resolveWake = resolve;
      });
    }

    if (cleanExit && isUpgrade && deps.onUpgradeSucceeded) {
      try {
        const { newVersion } = await deps.onUpgradeSucceeded();
        yield { kind: "restarted", newVersion };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        yield {
          kind: "error",
          message: `Upgrade completed but restart failed: ${message}`,
          fallback: "copy",
        };
      }
    }
  }

  return {
    canRunUpgrade,
    canRunInstall,
    runUpgrade(method) {
      return runArgv(method, UPGRADE_ARGV[method], true);
    },
    runInstall(method) {
      return runArgv(method, INSTALL_ARGV[method], false);
    },
  };
}

export function upgradeArgvFor(
  method: UpgradeMethod,
): readonly string[] | null {
  const argv = UPGRADE_ARGV[method];
  return argv ? Object.freeze([...argv]) : null;
}

export function installArgvFor(
  method: InstallMethod,
): readonly string[] | null {
  const argv = INSTALL_ARGV[method];
  return argv ? Object.freeze([...argv]) : null;
}
