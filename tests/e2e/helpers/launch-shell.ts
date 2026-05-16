import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { type ScratchEnv, sanitizedParentEnv } from "./scratch-env.js";

let launchCounter = 0;

// Launch the packaged Electron shell with `--remote-debugging-port=0`,
// scrape the CDP WebSocket endpoint from stdout, and return a handle
// the test can use to attach Playwright and to quit the shell.
//
// Background: production fuses set `EnableNodeCliInspectArguments:
// false` which blocks Node's `--inspect`. They do NOT block
// Chromium's renderer CDP. This was verified empirically during DS6
// (see desktop-shell-plan.md execution log) and is what makes E2E
// possible against the production-fused binary.

export interface ShellLaunchOptions {
  /** Path to the packaged shell binary. */
  readonly binary: string;
  /** Scratch env from createScratchEnv(); sets HOME/TMPDIR/etc. */
  readonly scratch: ScratchEnv;
  /** Optional override binary the shell should spawn for `nimbus`. */
  readonly nimbusBin?: string;
  /** Maximum time to wait for the CDP endpoint to appear in stdout. */
  readonly readinessTimeoutMs?: number;
}

export interface ShellHandle {
  /** Browser-level CDP WebSocket endpoint (from the banner). */
  readonly cdpEndpoint: string;
  /** HTTP endpoint for the CDP DevTools JSON (e.g. http://127.0.0.1:54667). */
  readonly cdpHttpEndpoint: string;
  readonly pid: number;
  readonly child: ChildProcess;
  /** Resolves with the captured stdout/stderr stream concatenated. */
  readonly logs: () => string;
  /** Send SIGTERM (or taskkill /T on Windows) and wait for exit. */
  shutdown(): Promise<void>;
  /** True once the underlying process has exited. */
  hasExited(): boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
// The shell's own SHUTDOWN_GRACE_MS (src/main/index.ts) is 5s for the
// /api/system/shutdown fetch + ~250ms post-SIGTERM grace before app.exit(0).
// Give the harness more time than that so we don't SIGKILL the shell mid-
// shutdown and orphan the detached nimbus child (it lives in its own
// process group, so the SIGKILL to -pid does not reap it).
const SHUTDOWN_GRACE_MS = 10_000;
const CDP_BANNER = /DevTools listening on (ws:\/\/[^\s]+)/;

async function waitForCdpHttp(
  httpEndpoint: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${httpEndpoint}/json/version`);
      if (res.status === 200) return;
      lastError = new Error(`status ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `CDP HTTP at ${httpEndpoint}/json/version not reachable within ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

export async function launchPackagedShell(
  options: ShellLaunchOptions,
): Promise<ShellHandle> {
  const env: NodeJS.ProcessEnv = {
    ...sanitizedParentEnv(),
    ...options.scratch.env,
    // Quiet the dock icon on macOS so the runner doesn't flash one
    // per test; this is purely cosmetic and has no effect on what
    // we assert.
    ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
  };
  if (options.nimbusBin) {
    env.NIMBUS_DESKTOP_NIMBUS_BIN = options.nimbusBin;
  }

  // Electron's `app.getPath("userData")` resolves via NSSearchPath on
  // macOS, NOT via $HOME — so a scratch HOME does NOT isolate the
  // Chromium profile directory. Without `--user-data-dir`, every test
  // run reuses `~/Library/Application Support/@nimbus/desktop` and
  // back-to-back launches race over Chromium's SingletonLock — the
  // second instance relays to the first (which it sees as alive via
  // the lock file) and exits almost immediately, emitting a spurious
  // `before-quit` ~1ms after main() begins. The same race fires
  // within a single spec if two sub-launches share a userData path,
  // so we mint a fresh directory per launch (the relaunch spec
  // launches twice against the same scratch root by design).
  // Empirically verified during DS7.
  const launchSeq = ++launchCounter;
  const userDataDir = path.join(
    options.scratch.root,
    `userData-${launchSeq}-${process.pid}`,
  );
  mkdirSync(userDataDir, { recursive: true });

  const child = spawn(
    options.binary,
    [
      `--user-data-dir=${userDataDir}`,
      "--remote-debugging-port=0",
      // Chromium 111+ refuses CDP WebSocket upgrades whose Origin
      // header does not match an allow-list. Playwright's
      // `connectOverCDP` connects from a Node process whose Origin
      // is empty/random, so the upgrade is rejected without this
      // flag. The port stays bound to 127.0.0.1 (browser default),
      // so the allow-list is only consulted in-process.
      "--remote-allow-origins=*",
      // No-sandbox is needed on Linux CI runners where the SUID
      // sandbox helper is not installed. Harmless elsewhere — the
      // four-flag webPreferences sandbox baseline (DS3) is what
      // matters for the security posture, not the chrome-sandbox
      // helper for the GPU process.
      "--no-sandbox",
      // Chromium accesses the macOS Keychain (and Linux
      // gnome-keyring) at startup to derive an encryption key for
      // cookies/profiles. Under a scratch HOME the lookup stalls
      // indefinitely on macOS — TCP accepts on the CDP port but the
      // HTTP/WS responder never replies, and `/json/version` hangs
      // forever. `--use-mock-keychain` (macOS) and
      // `--password-store=basic` (Linux) make Chromium use an
      // in-process secret store so startup completes immediately.
      // Empirically verified during DS7 against a scratch-HOME run
      // of the packaged shell.
      "--use-mock-keychain",
      "--password-store=basic",
    ],
    {
      env,
      // Run from the scratch root so the child `nimbus` the shell
      // spawns inherits a cwd that is NOT a Nimbus workspace. Without
      // this the shell inherits the test runner's cwd (the desktop
      // repo, a Cargo workspace adjacent to nimbus/) which triggers
      // the codegen preflight against a real workspace at startup
      // and stalls discovery past the test timeout.
      cwd: options.scratch.root,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );

  const chunks: string[] = [];
  child.stdout?.on("data", (b) => chunks.push(b.toString("utf8")));
  child.stderr?.on("data", (b) => chunks.push(b.toString("utf8")));

  let exited = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  child.once("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    exitSignal = signal;
  });

  const cdpEndpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `shell did not print a CDP endpoint within ${
            options.readinessTimeoutMs ?? DEFAULT_TIMEOUT_MS
          }ms (exited=${exited} code=${exitCode} signal=${exitSignal})\n--- shell logs ---\n${chunks.join("")}`,
        ),
      );
    }, options.readinessTimeoutMs ?? DEFAULT_TIMEOUT_MS);

    let resolved = false;
    const onData = (buf: Buffer) => {
      const text = buf.toString("utf8");
      const match = text.match(CDP_BANNER);
      if (match && !resolved) {
        resolved = true;
        cleanup();
        resolve(match[1]);
      }
    };
    const onExit = () => {
      if (resolved) return;
      cleanup();
      reject(
        new Error(
          `shell exited before printing a CDP endpoint (code=${exitCode} signal=${exitSignal})\n--- shell logs ---\n${chunks.join("")}`,
        ),
      );
    };
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    }
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
  });

  const cdpUrl = new URL(cdpEndpoint);
  const cdpHttpEndpoint = `http://${cdpUrl.hostname}:${cdpUrl.port}`;
  // The banner prints before Chromium binds the CDP HTTP port, on
  // some macOS builds. Poll `/json/version` until it responds before
  // returning so the caller can immediately `chromium.connectOverCDP`.
  await waitForCdpHttp(cdpHttpEndpoint, 15_000);
  return {
    cdpEndpoint,
    cdpHttpEndpoint,
    pid: child.pid ?? 0,
    child,
    logs: () => chunks.join(""),
    hasExited: () => exited,
    shutdown: async () => {
      if (exited) return;
      const pid = child.pid;
      if (pid === undefined) return;
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          const tk = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
            stdio: "ignore",
          });
          const done = () => resolve();
          tk.once("exit", done);
          tk.once("error", done);
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
      const gracefulExit = await Promise.race([
        new Promise<boolean>((r) => child.once("exit", () => r(true))),
        new Promise<boolean>((r) =>
          setTimeout(() => r(false), SHUTDOWN_GRACE_MS),
        ),
      ]);
      if (gracefulExit) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    },
  };
}
