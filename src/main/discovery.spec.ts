import { promises as fs, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  pidIsLive,
  readLiveServerDiscovery,
  readServerDiscoveryRecord,
  type ServerDiscoveryRecord,
} from "./discovery.js";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(path.join(tmpdir(), "nimbus-discovery-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

const LIVE_RECORD: ServerDiscoveryRecord = {
  pid: 4242,
  address: "127.0.0.1:8080",
  startedAt: "2026-05-15T00:00:00Z",
  version: "0.1.31",
  protocolVersions: ["nimbus.v2"],
};

describe("readServerDiscoveryRecord", () => {
  it("returns null when the file does not exist", async () => {
    const record = await readServerDiscoveryRecord(
      path.join(workdir, "missing.json"),
    );
    expect(record).toBeNull();
  });

  it("parses a well-formed discovery file", async () => {
    const target = path.join(workdir, "server.json");
    await fs.writeFile(target, JSON.stringify(LIVE_RECORD));
    const record = await readServerDiscoveryRecord(target);
    expect(record).toEqual(LIVE_RECORD);
  });

  it("removes and returns null on malformed JSON", async () => {
    const target = path.join(workdir, "server.json");
    await fs.writeFile(target, "{ this is not json");
    const record = await readServerDiscoveryRecord(target);
    expect(record).toBeNull();
    await expect(fs.access(target)).rejects.toThrow();
  });

  it("removes and returns null when required fields are missing", async () => {
    const target = path.join(workdir, "server.json");
    await fs.writeFile(target, JSON.stringify({ pid: 1, address: "x" }));
    const record = await readServerDiscoveryRecord(target);
    expect(record).toBeNull();
    await expect(fs.access(target)).rejects.toThrow();
  });
});

describe("readLiveServerDiscovery", () => {
  it("returns the record when the pid is live", async () => {
    const target = path.join(workdir, "server.json");
    await fs.writeFile(target, JSON.stringify(LIVE_RECORD));
    const record = await readLiveServerDiscovery(
      { serverDiscoveryPath: target },
      () => true,
    );
    expect(record).toEqual(LIVE_RECORD);
  });

  it("evicts the file and returns null when the pid is not live", async () => {
    const target = path.join(workdir, "server.json");
    await fs.writeFile(target, JSON.stringify(LIVE_RECORD));
    const record = await readLiveServerDiscovery(
      { serverDiscoveryPath: target },
      () => false,
    );
    expect(record).toBeNull();
    await expect(fs.access(target)).rejects.toThrow();
  });
});

describe("pidIsLive", () => {
  it("returns true for the current process", () => {
    expect(pidIsLive(process.pid)).toBe(true);
  });

  it("returns false for a clearly impossible pid (0)", () => {
    expect(pidIsLive(0)).toBe(false);
  });

  it("returns false for a stale high-numbered pid that does not exist", () => {
    // Pick a pid extremely unlikely to be in use. If by cosmic
    // accident the host has 2_147_483_640+ live processes, this
    // test will be flaky; in practice it is safe.
    expect(pidIsLive(2_147_483_640)).toBe(false);
  });
});
