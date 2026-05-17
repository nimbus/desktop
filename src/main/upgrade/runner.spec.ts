import { EventEmitter, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  InstallMethod,
  RunnerEvent,
  UpgradeMethod,
} from "../../shared/ipc-types.js";
import {
  buildSanitizedPath,
  createUpgradeRunner,
  installArgvFor,
  upgradeArgvFor,
} from "./runner.js";

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
}

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: {
    shell?: boolean;
    env?: NodeJS.ProcessEnv;
    stdio?: unknown;
    windowsHide?: boolean;
  };
  child: FakeChild;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  return child;
}

function makeSpawn(): {
  spawn: (
    command: string,
    args: readonly string[],
    options: SpawnCall["options"],
  ) => FakeChild;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (command, args, options) => {
      const child = makeFakeChild();
      calls.push({ command, args, options, child });
      return child;
    },
  };
}

async function collect(
  iter: AsyncIterable<RunnerEvent>,
): Promise<RunnerEvent[]> {
  const out: RunnerEvent[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

const REAL_BREW_ARGV = [
  "brew",
  "upgrade",
  "--cask",
  "nimbus/tap/nimbus",
] as const;

const REAL_INSTALL_ARGV = [
  "brew",
  "install",
  "--cask",
  "nimbus/tap/nimbus",
] as const;

describe("buildSanitizedPath", () => {
  it("prepends /opt/homebrew/bin and /usr/local/bin on darwin", () => {
    const result = buildSanitizedPath("darwin", "/usr/bin:/bin");
    expect(result.split(":")).toEqual([
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ]);
  });

  it("deduplicates entries when the augment already exists in PATH", () => {
    const result = buildSanitizedPath(
      "darwin",
      "/opt/homebrew/bin:/usr/local/bin:/usr/bin",
    );
    expect(result.split(":")).toEqual([
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
    ]);
  });

  it("uses semicolons on win32", () => {
    const result = buildSanitizedPath(
      "win32",
      "C:\\Windows;C:\\Windows\\System32",
    );
    expect(result.split(";")).toEqual(["C:\\Windows", "C:\\Windows\\System32"]);
  });

  it("returns just the augment when PATH is undefined", () => {
    expect(buildSanitizedPath("darwin", undefined)).toBe(
      "/opt/homebrew/bin:/usr/local/bin",
    );
  });
});

describe("upgradeArgvFor / installArgvFor", () => {
  it("returns the exact brew argv (the only background-runnable upgrade method)", () => {
    expect(upgradeArgvFor("brew")).toEqual(REAL_BREW_ARGV);
  });

  it("returns null for every method that requires sudo/TTY", () => {
    const sudoMethods: UpgradeMethod[] = [
      "apt",
      "dnf",
      "install-script",
      "source",
      "unknown",
    ];
    for (const method of sudoMethods) {
      expect(upgradeArgvFor(method)).toBeNull();
    }
  });

  it("install table mirrors upgrade for brew, refuses install-script and manual", () => {
    expect(installArgvFor("brew")).toEqual(REAL_INSTALL_ARGV);
    const refused: InstallMethod[] = ["install-script", "manual"];
    for (const method of refused) {
      expect(installArgvFor(method)).toBeNull();
    }
  });
});

describe("createUpgradeRunner — capability probes", () => {
  it("canRunUpgrade('brew') is true when brew lives at /opt/homebrew/bin", async () => {
    const access = vi
      .fn()
      .mockImplementation(async (p: string) => p === "/opt/homebrew/bin/brew");
    const runner = createUpgradeRunner({
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      accessExecutable: access,
    });
    expect(await runner.canRunUpgrade("brew")).toBe(true);
  });

  it("canRunUpgrade('brew') is false when brew is not on PATH", async () => {
    const access = vi.fn().mockResolvedValue(false);
    const runner = createUpgradeRunner({
      env: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      accessExecutable: access,
    });
    expect(await runner.canRunUpgrade("brew")).toBe(false);
  });

  it.each<UpgradeMethod>([
    "apt",
    "dnf",
    "install-script",
    "source",
    "unknown",
  ])("canRunUpgrade('%s') is false (sudo/TTY required, table entry is null)", async (method) => {
    const access = vi.fn().mockResolvedValue(true);
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: access,
    });
    expect(await runner.canRunUpgrade(method)).toBe(false);
  });

  it("canRunUpgrade is always false on win32", async () => {
    const access = vi.fn().mockResolvedValue(true);
    const runner = createUpgradeRunner({
      env: { PATH: "C:\\Windows" },
      platform: "win32",
      accessExecutable: access,
    });
    expect(await runner.canRunUpgrade("brew")).toBe(false);
  });

  it("canRunInstall('brew') is true on darwin when brew exists; false for install-script and manual", async () => {
    const access = vi
      .fn()
      .mockImplementation(async (p: string) => p === "/opt/homebrew/bin/brew");
    const runner = createUpgradeRunner({
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      accessExecutable: access,
    });
    expect(await runner.canRunInstall("brew")).toBe(true);
    expect(await runner.canRunInstall("install-script")).toBe(false);
    expect(await runner.canRunInstall("manual")).toBe(false);
  });
});

describe("createUpgradeRunner — spawn boundary contract", () => {
  let spawnRig: ReturnType<typeof makeSpawn>;
  beforeEach(() => {
    spawnRig = makeSpawn();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runUpgrade('brew') spawns the exact argv with shell:false and never invokes a shell string", async () => {
    const access = vi.fn().mockResolvedValue(true);
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: access,
      spawn: spawnRig.spawn as never,
    });
    const iter = runner.runUpgrade("brew");
    const drain = collect(iter);
    // wait a tick for spawn to be called
    await new Promise((r) => setImmediate(r));
    expect(spawnRig.calls).toHaveLength(1);
    const call = spawnRig.calls[0];
    expect(call?.command).toBe("brew");
    expect(call?.args).toEqual(["upgrade", "--cask", "nimbus/tap/nimbus"]);
    expect(call?.options.shell).toBe(false);
    // sanity: no shell-style "sh -c" or "cmd.exe /c" appears anywhere
    const fullCommand = `${call?.command} ${call?.args.join(" ")}`;
    expect(fullCommand).not.toMatch(/sh\s+-c/);
    expect(fullCommand).not.toMatch(/cmd\.exe\s+\/c/);
    // close the child so the iterator finishes
    call?.child.emit("exit", 0, null);
    const events = await drain;
    expect(events.some((e) => e.kind === "started")).toBe(true);
    expect(events.some((e) => e.kind === "exit" && e.code === 0)).toBe(true);
  });

  it.each<UpgradeMethod>([
    "apt",
    "dnf",
    "install-script",
    "source",
    "unknown",
  ])("runUpgrade('%s') refuses to spawn and emits a copy-fallback error", async (method) => {
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: vi.fn().mockResolvedValue(true),
      spawn: spawnRig.spawn as never,
    });
    const events = await collect(runner.runUpgrade(method));
    expect(spawnRig.calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("error");
    if (events[0]?.kind === "error") {
      expect(events[0].fallback).toBe("copy");
    }
  });

  it("refuses to spawn when the required binary is not on the sanitized PATH", async () => {
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: vi.fn().mockResolvedValue(false),
      spawn: spawnRig.spawn as never,
    });
    const events = await collect(runner.runUpgrade("brew"));
    expect(spawnRig.calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("error");
  });

  it("splits stdout chunks on newlines and emits one stdout event per line", async () => {
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: vi.fn().mockResolvedValue(true),
      spawn: spawnRig.spawn as never,
    });
    const iter = runner.runUpgrade("brew");
    const drain = collect(iter);
    await new Promise((r) => setImmediate(r));
    const call = spawnRig.calls[0];
    if (!call) throw new Error("spawn was not called");
    // chunked output, including a partial line that lands after exit
    call.child.stdout.emit("data", "==> Downloading\nResolving dep");
    call.child.stdout.emit("data", "endencies\n==> Pouring\n");
    call.child.stdout.emit("data", "tail without newline");
    call.child.emit("exit", 0, null);
    const events = await drain;
    const stdoutLines = events
      .filter((e): e is RunnerEvent & { kind: "stdout" } => e.kind === "stdout")
      .map((e) => e.line);
    expect(stdoutLines).toEqual([
      "==> Downloading",
      "Resolving dependencies",
      "==> Pouring",
      "tail without newline",
    ]);
  });

  it("emits stderr lines with a separate kind", async () => {
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: vi.fn().mockResolvedValue(true),
      spawn: spawnRig.spawn as never,
    });
    const iter = runner.runUpgrade("brew");
    const drain = collect(iter);
    await new Promise((r) => setImmediate(r));
    const call = spawnRig.calls[0];
    if (!call) throw new Error("spawn was not called");
    call.child.stderr.emit("data", "warning: deprecated\n");
    call.child.emit("exit", 0, null);
    const events = await drain;
    expect(events.some((e) => e.kind === "stderr")).toBe(true);
  });

  it("strips trailing \\r so CRLF output does not leak carriage returns into the line text", async () => {
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: vi.fn().mockResolvedValue(true),
      spawn: spawnRig.spawn as never,
    });
    const iter = runner.runUpgrade("brew");
    const drain = collect(iter);
    await new Promise((r) => setImmediate(r));
    const call = spawnRig.calls[0];
    if (!call) throw new Error("spawn was not called");
    call.child.stdout.emit("data", "==> CRLF\r\n");
    call.child.emit("exit", 0, null);
    const events = await drain;
    const line = events.find((e) => e.kind === "stdout");
    expect(line?.kind === "stdout" ? line.line : null).toBe("==> CRLF");
  });

  it("does not invoke onUpgradeSucceeded when the child exits non-zero", async () => {
    const onUpgradeSucceeded = vi.fn();
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: vi.fn().mockResolvedValue(true),
      spawn: spawnRig.spawn as never,
      onUpgradeSucceeded,
    });
    const iter = runner.runUpgrade("brew");
    const drain = collect(iter);
    await new Promise((r) => setImmediate(r));
    const call = spawnRig.calls[0];
    if (!call) throw new Error("spawn was not called");
    call.child.emit("exit", 1, null);
    const events = await drain;
    expect(onUpgradeSucceeded).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === "exit" && e.code === 1)).toBe(true);
    expect(events.some((e) => e.kind === "restarted")).toBe(false);
  });

  it("triggers the restart hook on exit 0 and yields a restarted event with the new version", async () => {
    const onUpgradeSucceeded = vi
      .fn()
      .mockResolvedValue({ newVersion: "0.1.41" });
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: vi.fn().mockResolvedValue(true),
      spawn: spawnRig.spawn as never,
      onUpgradeSucceeded,
    });
    const iter = runner.runUpgrade("brew");
    const drain = collect(iter);
    await new Promise((r) => setImmediate(r));
    const call = spawnRig.calls[0];
    if (!call) throw new Error("spawn was not called");
    call.child.emit("exit", 0, null);
    const events = await drain;
    expect(onUpgradeSucceeded).toHaveBeenCalledOnce();
    const restarted = events.find((e) => e.kind === "restarted");
    expect(restarted).toBeDefined();
    if (restarted?.kind === "restarted") {
      expect(restarted.newVersion).toBe("0.1.41");
    }
  });

  it("emits an error if the restart hook throws (no orphan upgrading state)", async () => {
    const onUpgradeSucceeded = vi
      .fn()
      .mockRejectedValue(new Error("readiness timeout"));
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: vi.fn().mockResolvedValue(true),
      spawn: spawnRig.spawn as never,
      onUpgradeSucceeded,
    });
    const iter = runner.runUpgrade("brew");
    const drain = collect(iter);
    await new Promise((r) => setImmediate(r));
    spawnRig.calls[0]?.child.emit("exit", 0, null);
    const events = await drain;
    const errorEvent = events.find((e) => e.kind === "error");
    expect(errorEvent).toBeDefined();
    if (errorEvent?.kind === "error") {
      expect(errorEvent.message).toContain("readiness timeout");
      expect(errorEvent.fallback).toBe("copy");
    }
  });

  it("does NOT trigger the restart hook for runInstall, even on exit 0", async () => {
    const onUpgradeSucceeded = vi.fn();
    const runner = createUpgradeRunner({
      env: { PATH: "/opt/homebrew/bin" },
      platform: "darwin",
      accessExecutable: vi.fn().mockResolvedValue(true),
      spawn: spawnRig.spawn as never,
      onUpgradeSucceeded,
    });
    const iter = runner.runInstall("brew");
    const drain = collect(iter);
    await new Promise((r) => setImmediate(r));
    const call = spawnRig.calls[0];
    if (!call) throw new Error("spawn was not called");
    expect(call.args).toEqual(["install", "--cask", "nimbus/tap/nimbus"]);
    call.child.emit("exit", 0, null);
    await drain;
    expect(onUpgradeSucceeded).not.toHaveBeenCalled();
  });

  it("emits a copy-fallback error on win32 even when the tag would otherwise be valid", async () => {
    const runner = createUpgradeRunner({
      env: { PATH: "C:\\Windows" },
      platform: "win32",
      accessExecutable: vi.fn().mockResolvedValue(true),
      spawn: spawnRig.spawn as never,
    });
    const events = await collect(runner.runUpgrade("brew"));
    expect(spawnRig.calls).toHaveLength(0);
    expect(events[0]?.kind).toBe("error");
  });
});
