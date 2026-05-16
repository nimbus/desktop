import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerDiscoveryRecord } from "./discovery.js";
import {
  buildUiUrl,
  NimbusBinaryNotFoundError,
  normalizeLoopbackAddress,
  resolveNimbusExecutable,
  resolveServer,
  ServerNotRunningError,
  ServerReadinessTimeoutError,
} from "./server.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "nimbus-server-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const SAMPLE: ServerDiscoveryRecord = {
  pid: 4242,
  address: "127.0.0.1:9090",
  startedAt: "2026-05-15T00:00:00Z",
  version: "0.1.31",
  protocolVersions: ["nimbus.v2"],
};

function writeRecord(
  target: string,
  record: ServerDiscoveryRecord,
): Promise<void> {
  return fs.writeFile(target, JSON.stringify(record));
}

describe("normalizeLoopbackAddress", () => {
  it("rewrites 0.0.0.0 to 127.0.0.1", () => {
    expect(normalizeLoopbackAddress("0.0.0.0:8080")).toBe("127.0.0.1:8080");
  });

  it("rewrites :: and [::] to 127.0.0.1", () => {
    expect(normalizeLoopbackAddress("::8080")).toBe("127.0.0.1:8080");
    expect(normalizeLoopbackAddress("[::]:8080")).toBe("127.0.0.1:8080");
  });

  it("rewrites IPv6 loopback to IPv4 loopback for renderer compat", () => {
    expect(normalizeLoopbackAddress("[::1]:8080")).toBe("127.0.0.1:8080");
  });

  it("leaves an already-loopback address alone", () => {
    expect(normalizeLoopbackAddress("127.0.0.1:8080")).toBe("127.0.0.1:8080");
  });

  it("returns the input when there is no colon (unparseable)", () => {
    expect(normalizeLoopbackAddress("localhost")).toBe("localhost");
  });
});

describe("buildUiUrl", () => {
  it("builds an http://.../ui/ URL", () => {
    expect(buildUiUrl(SAMPLE)).toBe("http://127.0.0.1:9090/ui/");
  });

  it("normalizes 0.0.0.0 before building", () => {
    expect(buildUiUrl({ ...SAMPLE, address: "0.0.0.0:9090" })).toBe(
      "http://127.0.0.1:9090/ui/",
    );
  });
});

describe("resolveServer", () => {
  it("returns the live discovery record when one exists", async () => {
    const serverDiscoveryPath = path.join(workdir, "server.json");
    await writeRecord(serverDiscoveryPath, SAMPLE);
    const envelope = await resolveServer({
      ensure: false,
      paths: {
        authTokenPath: path.join(workdir, "token"),
        serverDiscoveryPath,
        auditLogPath: path.join(workdir, "logs.jsonl"),
      },
      pidChecker: () => true,
    });
    expect(envelope.origin).toBe("discovered");
    expect(envelope.url).toBe("http://127.0.0.1:9090/ui/");
    expect(envelope.spawned).toBeNull();
  });

  it("throws ServerNotRunningError when ensure=false and no live server", async () => {
    await expect(
      resolveServer({
        ensure: false,
        paths: {
          authTokenPath: path.join(workdir, "token"),
          serverDiscoveryPath: path.join(workdir, "server.json"),
          auditLogPath: path.join(workdir, "logs.jsonl"),
        },
        pidChecker: () => false,
      }),
    ).rejects.toBeInstanceOf(ServerNotRunningError);
  });

  it("times out after readinessTimeoutMs when ensure=true but spawn never registers", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let nowValue = 0;
    const now = () => {
      const value = nowValue;
      nowValue += 100;
      return value;
    };
    await expect(
      resolveServer({
        ensure: true,
        paths: {
          authTokenPath: path.join(workdir, "token"),
          serverDiscoveryPath: path.join(workdir, "server.json"),
          auditLogPath: path.join(workdir, "logs.jsonl"),
        },
        pidChecker: () => false,
        nimbusExecutable: process.execPath,
        readinessTimeoutMs: 250,
        pollIntervalMs: 1,
        sleep,
        now,
        probe: async () => false,
      }),
    ).rejects.toBeInstanceOf(ServerReadinessTimeoutError);
    // sleep should have been called at least once during the poll
    expect(sleep).toHaveBeenCalled();
  });

  it("returns spawned envelope when the discovery record appears while polling", async () => {
    const serverDiscoveryPath = path.join(workdir, "server.json");
    let pollCount = 0;
    const sleep = vi.fn().mockImplementation(async () => {
      pollCount++;
      if (pollCount === 2) {
        await writeRecord(serverDiscoveryPath, SAMPLE);
      }
    });
    let tick = 0;
    const now = () => {
      const value = tick;
      tick += 1;
      return value;
    };
    const envelope = await resolveServer({
      ensure: true,
      paths: {
        authTokenPath: path.join(workdir, "token"),
        serverDiscoveryPath,
        auditLogPath: path.join(workdir, "logs.jsonl"),
      },
      pidChecker: () => true,
      nimbusExecutable: process.execPath,
      pollIntervalMs: 1,
      readinessTimeoutMs: 100,
      sleep,
      now,
      probe: async () => true,
    });
    expect(envelope.origin).toBe("spawned");
    expect(envelope.url).toBe("http://127.0.0.1:9090/ui/");
    expect(envelope.spawned).not.toBeNull();
    envelope.spawned?.child.kill("SIGTERM");
  });

  it("throws NimbusBinaryNotFoundError when ensure=true and no nimbus binary is reachable", async () => {
    await expect(
      resolveServer({
        ensure: true,
        paths: {
          authTokenPath: path.join(workdir, "token"),
          serverDiscoveryPath: path.join(workdir, "server.json"),
          auditLogPath: path.join(workdir, "logs.jsonl"),
        },
        env: { HOME: "/nonexistent-home", PATH: "/this/path/has/no/nimbus" },
        pidChecker: () => false,
      }),
    ).rejects.toBeInstanceOf(NimbusBinaryNotFoundError);
  });
});

describe("resolveNimbusExecutable — NIMBUS_DESKTOP_NIMBUS_BIN override", () => {
  it("returns the override path when it is executable", async () => {
    // process.execPath (the running node binary) is guaranteed to be
    // executable and to exist on every CI runner — a stable fixture
    // for proving the override is consulted before PATH.
    const resolved = await resolveNimbusExecutable({
      NIMBUS_DESKTOP_NIMBUS_BIN: process.execPath,
      PATH: "/nonexistent",
    });
    expect(resolved).toBe(process.execPath);
  });

  it("throws NimbusBinaryNotFoundError when the override is not executable", async () => {
    await expect(
      resolveNimbusExecutable({
        NIMBUS_DESKTOP_NIMBUS_BIN: "/definitely/not/a/binary/here",
        PATH: process.env.PATH,
      }),
    ).rejects.toBeInstanceOf(NimbusBinaryNotFoundError);
  });

  it("ignores an empty override and falls through to PATH", async () => {
    // Empty string should not short-circuit. A real production env can
    // expose `NIMBUS_DESKTOP_NIMBUS_BIN=""` from a misconfigured shell
    // profile; treating that as a hard override would brick the shell.
    await expect(
      resolveNimbusExecutable({
        NIMBUS_DESKTOP_NIMBUS_BIN: "",
        PATH: "/this/path/has/no/nimbus",
        HOME: "/nonexistent-home",
      }),
    ).rejects.toBeInstanceOf(NimbusBinaryNotFoundError);
  });
});
