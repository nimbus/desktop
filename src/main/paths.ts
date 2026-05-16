import path from "node:path";

// TypeScript port of crates/nimbus-server/src/local_server/paths.rs in
// nimbus/nimbus. Keep in sync — the discovery file path is the
// contract that lets the shell find a running `nimbus start`.

export type LocalServerPlatform = "linux" | "macos" | "windows";

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
  const home = requireEnv(env, "HOME", "linux");
  const dataRoot = path.join(
    envPath(env, "XDG_DATA_HOME") ?? path.join(home, ".local", "share"),
    "nimbus",
  );
  const stateRoot = path.join(
    envPath(env, "XDG_STATE_HOME") ?? path.join(home, ".local", "state"),
    "nimbus",
  );
  const runtimeRoot = envPath(env, "XDG_RUNTIME_DIR");
  const serverDiscoveryPath = runtimeRoot
    ? path.join(runtimeRoot, "nimbus", "server.json")
    : path.join(stateRoot, "run", "server.json");
  return {
    authTokenPath: path.join(dataRoot, "auth", "token"),
    serverDiscoveryPath,
    auditLogPath: path.join(stateRoot, "logs", "access.jsonl"),
  };
}

function resolveMacosPaths(
  env: Readonly<Record<string, string | undefined>>,
): LocalServerPaths {
  const home = requireEnv(env, "HOME", "macos");
  const applicationSupportRoot = path.join(
    home,
    "Library",
    "Application Support",
    "nimbus",
  );
  const tmpdir = envPath(env, "TMPDIR");
  const serverDiscoveryPath = tmpdir
    ? path.join(tmpdir, "nimbus", "server.json")
    : path.join(applicationSupportRoot, "run", "server.json");
  return {
    authTokenPath: path.join(applicationSupportRoot, "auth", "token"),
    serverDiscoveryPath,
    auditLogPath: path.join(home, "Library", "Logs", "nimbus", "access.jsonl"),
  };
}

function resolveWindowsPaths(
  env: Readonly<Record<string, string | undefined>>,
): LocalServerPaths {
  const localAppData =
    envPath(env, "LOCALAPPDATA") ??
    path.join(userProfileDir(env) ?? "C:\\Users\\Default", "AppData", "Local");
  const nimbusRoot = path.join(localAppData, "nimbus");
  return {
    authTokenPath: path.join(nimbusRoot, "auth", "token.json"),
    serverDiscoveryPath: path.join(nimbusRoot, "run", "server.json"),
    auditLogPath: path.join(nimbusRoot, "logs", "access.jsonl"),
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
  return path.join(drive, remainder);
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
