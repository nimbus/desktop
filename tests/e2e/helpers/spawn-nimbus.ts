import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";

import { type ScratchEnv, sanitizedParentEnv } from "./scratch-env.js";

// Spawn a real `nimbus` binary into an isolated scratch directory.
// The returned handle exposes the bound port + a graceful-shutdown
// helper that mirrors what the desktop shell does on quit
// (POST /api/system/shutdown, then SIGTERM, then SIGKILL).

export interface NimbusServer {
  readonly baseURL: string;
  readonly port: number;
  readonly pid: number;
  readonly tokenPath: string;
  readonly discoveryPath: string;
  readToken(): string;
  shutdown(): Promise<void>;
  hasExited(): boolean;
}

const READINESS_TIMEOUT_MS = 60_000;
const READINESS_POLL_MS = 200;
const SHUTDOWN_GRACE_MS = 5_000;

export async function spawnNimbusServer(
  binary: string,
  scratch: ScratchEnv,
): Promise<NimbusServer> {
  const port = await allocateFreePort();
  const baseURL = `http://127.0.0.1:${port}`;
  const env = {
    ...sanitizedParentEnv(),
    ...scratch.env,
    NIMBUS_E2E: "1",
  };

  const child = spawn(
    binary,
    ["start", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: scratch.root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );

  const logChunks: string[] = [];
  child.stdout?.on("data", (chunk) => {
    logChunks.push(chunk.toString("utf8"));
  });
  child.stderr?.on("data", (chunk) => {
    logChunks.push(chunk.toString("utf8"));
  });

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  try {
    await waitForReady(
      `${baseURL}/ui/auth`,
      READINESS_TIMEOUT_MS,
      () => exited,
    );
  } catch (err) {
    await terminate(child);
    throw new Error(
      `nimbus did not become ready at ${baseURL}: ${
        err instanceof Error ? err.message : String(err)
      }\n--- nimbus logs ---\n${logChunks.join("")}`,
    );
  }

  const handle: NimbusServer = {
    baseURL,
    port,
    pid: child.pid ?? 0,
    tokenPath: scratch.tokenPath,
    discoveryPath: scratch.discoveryPath,
    readToken: () => readTokenString(scratch.tokenPath),
    hasExited: () => exited,
    shutdown: async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SHUTDOWN_GRACE_MS);
        try {
          await fetch(`${baseURL}/api/system/shutdown`, {
            method: "POST",
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // fall through — POST may fail if the server is already down
      }
      await terminate(child);
    },
  };
  return handle;
}

async function allocateFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("net.createServer did not return an AddressInfo"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForReady(
  url: string,
  timeoutMs: number,
  isDead: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (isDead()) {
      throw new Error(
        `nimbus process exited before ${url} became ready (last error: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        })`,
      );
    }
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, READINESS_POLL_MS));
  }
  throw new Error(
    `timed out after ${timeoutMs}ms; last error: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      child.kill();
    } catch {}
    await new Promise<void>((resolve) => {
      const taskkill = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
        stdio: "ignore",
      });
      const done = () => resolve();
      taskkill.once("exit", done);
      taskkill.once("error", done);
      setTimeout(done, 3_000);
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
    }),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), SHUTDOWN_GRACE_MS),
    ),
  ]);
  if (exited) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

interface TokenRecord {
  token: string;
}

function readTokenString(tokenPath: string): string {
  const raw = readFileSync(tokenPath, "utf8").trim();
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw) as Partial<TokenRecord>;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) {
      throw new Error(`token file ${tokenPath} has no .token field`);
    }
    return parsed.token;
  }
  if (raw.length === 0) {
    throw new Error(`token file ${tokenPath} is empty`);
  }
  return raw;
}
