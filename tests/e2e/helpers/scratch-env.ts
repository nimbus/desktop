import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// DS7 isolation primitive. A test must NEVER read or write the
// operator's real auth token or discovery file — that would let one
// flaky test brick the developer's local Nimbus session. So every
// spec runs against a fresh scratch directory and tells both nimbus
// and the shell to use it via per-platform env vars.
//
// The shape mirrors `crates/nimbus-server/src/local_server/paths.rs`
// and `src/main/paths.ts` — keep all three in lock-step.

export interface ScratchEnv {
  /** Absolute root of the scratch directory; rm at teardown. */
  readonly root: string;
  /** Env vars to merge into the spawned process. */
  readonly env: Record<string, string>;
  /** Where the running server writes its auth token. */
  readonly tokenPath: string;
  /** Where the running server writes its discovery JSON. */
  readonly discoveryPath: string;
}

export function createScratchEnv(): ScratchEnv {
  const root = mkdtempSync(path.join(tmpdir(), "nimbus-desktop-e2e-"));
  if (process.platform === "darwin") {
    const appSupport = path.join(
      root,
      "Library",
      "Application Support",
      "nimbus",
    );
    const macTmp = path.join(root, "tmp");
    return {
      root,
      env: { HOME: root, TMPDIR: macTmp },
      tokenPath: path.join(appSupport, "auth", "token"),
      discoveryPath: path.join(macTmp, "nimbus", "server.json"),
    };
  }
  if (process.platform === "win32") {
    const localAppData = path.join(root, "AppData", "Local");
    return {
      root,
      env: { LOCALAPPDATA: localAppData, USERPROFILE: root },
      tokenPath: path.join(localAppData, "nimbus", "auth", "token.json"),
      discoveryPath: path.join(localAppData, "nimbus", "run", "server.json"),
    };
  }
  const xdgData = path.join(root, "xdg-data");
  const xdgState = path.join(root, "xdg-state");
  const xdgRuntime = path.join(root, "xdg-runtime");
  return {
    root,
    env: {
      HOME: root,
      XDG_DATA_HOME: xdgData,
      XDG_STATE_HOME: xdgState,
      XDG_RUNTIME_DIR: xdgRuntime,
    },
    tokenPath: path.join(xdgData, "nimbus", "auth", "token"),
    discoveryPath: path.join(xdgRuntime, "nimbus", "server.json"),
  };
}

export function disposeScratchEnv(scratch: ScratchEnv): void {
  try {
    rmSync(scratch.root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; the OS will reclaim /tmp eventually
  }
}

// Strip every env var that the scratch env explicitly sets, so the
// child process cannot inherit a developer's real paths through a
// stale variable that the test forgot to override.
export function sanitizedParentEnv(): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "HOME",
    "TMPDIR",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
  ]) {
    delete inherited[key];
  }
  return inherited;
}
