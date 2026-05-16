import { describe, expect, it } from "vitest";

import { resolveLocalServerPaths } from "./paths.js";

describe("resolveLocalServerPaths — linux", () => {
  it("uses the XDG overrides when present", () => {
    const paths = resolveLocalServerPaths("linux", {
      HOME: "/Users/jack",
      XDG_DATA_HOME: "/tmp/data",
      XDG_STATE_HOME: "/tmp/state",
      XDG_RUNTIME_DIR: "/tmp/runtime",
    });
    expect(paths.authTokenPath).toBe("/tmp/data/nimbus/auth/token");
    expect(paths.serverDiscoveryPath).toBe("/tmp/runtime/nimbus/server.json");
    expect(paths.auditLogPath).toBe("/tmp/state/nimbus/logs/access.jsonl");
  });

  it("falls back to ~/.local conventions when XDG vars are absent", () => {
    const paths = resolveLocalServerPaths("linux", { HOME: "/Users/jack" });
    expect(paths.authTokenPath).toBe(
      "/Users/jack/.local/share/nimbus/auth/token",
    );
    expect(paths.serverDiscoveryPath).toBe(
      "/Users/jack/.local/state/nimbus/run/server.json",
    );
    expect(paths.auditLogPath).toBe(
      "/Users/jack/.local/state/nimbus/logs/access.jsonl",
    );
  });

  it("throws when HOME is unset", () => {
    expect(() => resolveLocalServerPaths("linux", {})).toThrow(/HOME/);
  });
});

describe("resolveLocalServerPaths — macos", () => {
  it("prefers TMPDIR for the discovery file", () => {
    const paths = resolveLocalServerPaths("macos", {
      HOME: "/Users/jack",
      TMPDIR: "/private/tmp/nimbus-test",
    });
    expect(paths.authTokenPath).toBe(
      "/Users/jack/Library/Application Support/nimbus/auth/token",
    );
    expect(paths.serverDiscoveryPath).toBe(
      "/private/tmp/nimbus-test/nimbus/server.json",
    );
    expect(paths.auditLogPath).toBe(
      "/Users/jack/Library/Logs/nimbus/access.jsonl",
    );
  });

  it("falls back to Application Support/run when TMPDIR is absent", () => {
    const paths = resolveLocalServerPaths("macos", { HOME: "/Users/jack" });
    expect(paths.serverDiscoveryPath).toBe(
      "/Users/jack/Library/Application Support/nimbus/run/server.json",
    );
  });
});

describe("resolveLocalServerPaths — windows", () => {
  it("uses LOCALAPPDATA when present", () => {
    const paths = resolveLocalServerPaths("windows", {
      LOCALAPPDATA: "C:\\Users\\jack\\AppData\\Local",
    });
    expect(paths.serverDiscoveryPath).toBe(
      "C:\\Users\\jack\\AppData\\Local/nimbus/run/server.json".replaceAll(
        "/",
        process.platform === "win32" ? "\\" : "/",
      ),
    );
  });

  it("falls back to USERPROFILE when LOCALAPPDATA is missing", () => {
    const paths = resolveLocalServerPaths("windows", {
      USERPROFILE: "C:\\Users\\jack",
    });
    // The fallback path goes through path.join, which on non-Windows
    // hosts uses POSIX separators. The contract is "AppData/Local
    // under the user profile, then nimbus/..." — assert structurally.
    expect(paths.authTokenPath).toContain("AppData");
    expect(paths.authTokenPath).toContain("Local");
    expect(paths.authTokenPath).toContain("nimbus");
    expect(paths.authTokenPath).toContain("auth");
    expect(paths.authTokenPath).toMatch(/token\.json$/);
  });

  it("uses HOMEDRIVE + HOMEPATH when USERPROFILE is missing", () => {
    const paths = resolveLocalServerPaths("windows", {
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\jack",
    });
    expect(paths.authTokenPath).toContain("nimbus");
    expect(paths.serverDiscoveryPath).toMatch(/server\.json$/);
  });
});
