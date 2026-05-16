import path from "node:path";

// TypeScript port of crates/nimbus-server/src/local_server/paths.rs in
// nimbus/nimbus. Keep in sync — the discovery file path is the
// contract that lets the shell find a running `nimbus start`.
//
// The functions below take a `LocalServerPlatform` argument so the
// *target* platform's path conventions must govern — not the host's.
// Use `path.posix` for linux/macos and `path.win32` for windows so
// that running the linux resolver on a Windows host (or vice versa,
// as happens in cross-platform CI test suites) still produces correct
// POSIX or Windows-shaped paths.

export type LocalServerPlatform = "linux" | "macos" | "windows";

function pathFor(platform: LocalServerPlatform): path.PlatformPath {
  return platform === "windows" ? path.win32 : path.posix;
}

export interface LocalServerPaths {
  readonly authTokenPath: string;
  readonly serverDiscoveryPath: string;
  readonly auditLogPath: string;
}

export function currentPlatform(): LocalServerPlatform {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "win32") return "windows";
  return "linux";
}

export function resolveLocalServerPaths(
  platform: LocalServerPlatform,
  env: Readonly<Record<string, string | undefined>>,
): LocalServerPaths {
  switch (platform) {
    case "linux":
      return resolveLinuxPaths(env);
    case "macos":
      return resolveMacosPaths(env);
    case "windows":
      return resolveWindowsPaths(env);
  }
}

export function resolveLocalServerPathsForCurrentPlatform(): LocalServerPaths {
  return resolveLocalServerPaths(currentPlatform(), process.env);
}

function resolveLinuxPaths(
  env: Readonly<Record<string, string | undefined>>,
): LocalServerPaths {
  const p = pathFor("linux");
  const home = requireEnv(env, "HOME", "linux");
  const dataRoot = p.join(
    envPath(env, "XDG_DATA_HOME") ?? p.join(home, ".local", "share"),
    "nimbus",
  );
  const stateRoot = p.join(
    envPath(env, "XDG_STATE_HOME") ?? p.join(home, ".local", "state"),
    "nimbus",
  );
  const runtimeRoot = envPath(env, "XDG_RUNTIME_DIR");
  const serverDiscoveryPath = runtimeRoot
    ? p.join(runtimeRoot, "nimbus", "server.json")
    : p.join(stateRoot, "run", "server.json");
  return {
    authTokenPath: p.join(dataRoot, "auth", "token"),
    serverDiscoveryPath,
    auditLogPath: p.join(stateRoot, "logs", "access.jsonl"),
  };
}

function resolveMacosPaths(
  env: Readonly<Record<string, string | undefined>>,
): LocalServerPaths {
  const p = pathFor("macos");
  const home = requireEnv(env, "HOME", "macos");
  const applicationSupportRoot = p.join(
    home,
    "Library",
    "Application Support",
    "nimbus",
  );
  const tmpdir = envPath(env, "TMPDIR");
  const serverDiscoveryPath = tmpdir
    ? p.join(tmpdir, "nimbus", "server.json")
    : p.join(applicationSupportRoot, "run", "server.json");
  return {
    authTokenPath: p.join(applicationSupportRoot, "auth", "token"),
    serverDiscoveryPath,
    auditLogPath: p.join(home, "Library", "Logs", "nimbus", "access.jsonl"),
  };
}

function resolveWindowsPaths(
  env: Readonly<Record<string, string | undefined>>,
): LocalServerPaths {
  const p = pathFor("windows");
  const localAppData =
    envPath(env, "LOCALAPPDATA") ??
    p.join(userProfileDir(env) ?? "C:\\Users\\Default", "AppData", "Local");
  const nimbusRoot = p.join(localAppData, "nimbus");
  return {
    authTokenPath: p.join(nimbusRoot, "auth", "token.json"),
    serverDiscoveryPath: p.join(nimbusRoot, "run", "server.json"),
    auditLogPath: p.join(nimbusRoot, "logs", "access.jsonl"),
  };
}

function envPath(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const value = env[key];
  return value && value.length > 0 ? value : undefined;
}

function userProfileDir(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const userProfile = envPath(env, "USERPROFILE");
  if (userProfile) return userProfile;
  const drive = env.HOMEDRIVE;
  const remainder = env.HOMEPATH;
  if (!drive || !remainder) return undefined;
  return path.win32.join(drive, remainder);
}

function requireEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  platform: LocalServerPlatform,
): string {
  const value = envPath(env, key);
  if (!value) {
    throw new Error(
      `${key} is not set; cannot resolve local server directories for ${platform}`,
    );
  }
  return value;
}
