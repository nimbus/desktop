import { promises as fs } from "node:fs";

import type { LocalServerPaths } from "./paths.js";

// TypeScript port of crates/nimbus-server/src/local_server/discovery.rs.
// The shell only ever READS this contract — the Rust binary owns
// writing + leasing. Stale records (PID not alive) are evicted on
// read so the shell never tries to talk to a dead server.

export const SERVER_DISCOVERY_PROTOCOL_VERSIONS = ["nimbus.v2"] as const;
export type ServerDiscoveryProtocolVersion =
  (typeof SERVER_DISCOVERY_PROTOCOL_VERSIONS)[number];

export interface ServerDiscoveryRecord {
  readonly pid: number;
  readonly address: string;
  readonly startedAt: string;
  readonly version: string;
  readonly protocolVersions: readonly string[];
}

export type PidChecker = (pid: number) => boolean;

export function pidIsLive(pid: number): boolean {
  if (pid <= 0 || !Number.isFinite(pid)) return false;
  try {
    // Node implements `process.kill(pid, 0)` cross-platform: on Unix
    // it sends signal 0 (existence probe), on Windows it calls
    // OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we cannot signal it (e.g.
    // owned by a different user). Treat as "live".
    return code === "EPERM";
  }
}

export async function readServerDiscoveryRecord(
  discoveryPath: string,
): Promise<ServerDiscoveryRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(discoveryPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isServerDiscoveryRecord(parsed)) {
      await removeFileIfExists(discoveryPath);
      return null;
    }
    return parsed;
  } catch {
    await removeFileIfExists(discoveryPath);
    return null;
  }
}

export async function readLiveServerDiscovery(
  paths: Pick<LocalServerPaths, "serverDiscoveryPath">,
  pidChecker: PidChecker = pidIsLive,
): Promise<ServerDiscoveryRecord | null> {
  const record = await readServerDiscoveryRecord(paths.serverDiscoveryPath);
  if (!record) return null;
  if (pidChecker(record.pid)) return record;
  await removeFileIfExists(paths.serverDiscoveryPath);
  return null;
}

async function removeFileIfExists(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

function isServerDiscoveryRecord(
  value: unknown,
): value is ServerDiscoveryRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.pid !== "number") return false;
  if (typeof candidate.address !== "string") return false;
  if (typeof candidate.startedAt !== "string") return false;
  if (typeof candidate.version !== "string") return false;
  if (!Array.isArray(candidate.protocolVersions)) return false;
  return candidate.protocolVersions.every((v) => typeof v === "string");
}
