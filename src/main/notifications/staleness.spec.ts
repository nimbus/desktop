import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StalenessInfo } from "../../shared/ipc-types.js";
import {
  createStalenessNotifier,
  type NotificationConstructor,
  type NotificationLike,
  readNotifiedFile,
  writeNotifiedFile,
} from "./staleness.js";

interface NotificationCall {
  options: ConstructorParameters<NotificationConstructor>[0];
  instance: NotificationLike & {
    shown: boolean;
    clickHandlers: Array<() => void>;
  };
}

function makeNotificationCtor(): {
  ctor: NotificationConstructor;
  calls: NotificationCall[];
} {
  const calls: NotificationCall[] = [];
  class FakeNotification implements NotificationLike {
    shown = false;
    clickHandlers: Array<() => void> = [];
    constructor(
      public options: ConstructorParameters<NotificationConstructor>[0],
    ) {
      calls.push({ options, instance: this });
    }
    show(): void {
      this.shown = true;
    }
    on(event: "click", listener: () => void): unknown {
      if (event === "click") this.clickHandlers.push(listener);
      return this;
    }
  }
  return {
    ctor: FakeNotification as unknown as NotificationConstructor,
    calls,
  };
}

function makeInfo(over: Partial<StalenessInfo> = {}): StalenessInfo {
  return {
    current: "0.1.40",
    latest: "0.1.41",
    available: true,
    url: "https://example.com/release",
    host: "localhost",
    ...over,
  };
}

function makeFetchOk(info: StalenessInfo): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => info,
  } as unknown as Response) as unknown as typeof fetch;
}

async function mkTempDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "nimbus-staleness-"));
}

let tempDirs: string[] = [];
beforeEach(() => {
  tempDirs = [];
});
afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function makeDir(): Promise<string> {
  const dir = await mkTempDir();
  tempDirs.push(dir);
  return dir;
}

describe("readNotifiedFile / writeNotifiedFile", () => {
  it("round-trips a set of versions", async () => {
    const dir = await makeDir();
    await writeNotifiedFile(dir, new Set(["0.1.41", "0.1.42"]));
    const round = await readNotifiedFile(dir);
    expect([...round].sort()).toEqual(["0.1.41", "0.1.42"]);
  });

  it("returns an empty set when the file is missing", async () => {
    const dir = await makeDir();
    const result = await readNotifiedFile(dir);
    expect(result.size).toBe(0);
  });

  it("returns an empty set when the file is malformed JSON", async () => {
    const dir = await makeDir();
    await fs.writeFile(
      path.join(dir, "notified-versions.json"),
      "not json",
      "utf8",
    );
    const result = await readNotifiedFile(dir);
    expect(result.size).toBe(0);
  });

  it("ignores non-string entries inside the array", async () => {
    const dir = await makeDir();
    await fs.writeFile(
      path.join(dir, "notified-versions.json"),
      JSON.stringify({ versions: ["0.1.41", 42, null, "0.1.42"] }),
      "utf8",
    );
    const result = await readNotifiedFile(dir);
    expect([...result].sort()).toEqual(["0.1.41", "0.1.42"]);
  });
});

describe("createStalenessNotifier", () => {
  it("fires a notification on first detection of an available version", async () => {
    const dir = await makeDir();
    const { ctor, calls } = makeNotificationCtor();
    const notifier = createStalenessNotifier({
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: dir,
      fetchFn: makeFetchOk(makeInfo()),
      Notification: ctor,
    });
    await notifier.pollOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.title).toBe("Nimbus 0.1.41 available");
    expect(calls[0]?.instance.shown).toBe(true);
    const persisted = await readNotifiedFile(dir);
    expect(persisted.has("0.1.41")).toBe(true);
  });

  it("does NOT re-notify for the same latest across two polls", async () => {
    const dir = await makeDir();
    const { ctor, calls } = makeNotificationCtor();
    const notifier = createStalenessNotifier({
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: dir,
      fetchFn: makeFetchOk(makeInfo()),
      Notification: ctor,
    });
    await notifier.pollOnce();
    await notifier.pollOnce();
    expect(calls).toHaveLength(1);
  });

  it("does NOT re-notify after a process restart (notified-versions.json carries state)", async () => {
    const dir = await makeDir();
    await writeNotifiedFile(dir, new Set(["0.1.41"]));
    const { ctor, calls } = makeNotificationCtor();
    const notifier = createStalenessNotifier({
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: dir,
      fetchFn: makeFetchOk(makeInfo()),
      Notification: ctor,
    });
    await notifier.pollOnce();
    expect(calls).toHaveLength(0);
  });

  it("re-notifies when a new latest appears", async () => {
    const dir = await makeDir();
    const { ctor, calls } = makeNotificationCtor();
    let info = makeInfo();
    const fetchFn = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => info,
    })) as unknown as typeof fetch;
    const notifier = createStalenessNotifier({
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: dir,
      fetchFn,
      Notification: ctor,
    });
    await notifier.pollOnce();
    expect(calls).toHaveLength(1);
    info = makeInfo({ latest: "0.1.42" });
    await notifier.pollOnce();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.options.title).toBe("Nimbus 0.1.42 available");
  });

  it("does not notify when available is false", async () => {
    const dir = await makeDir();
    const { ctor, calls } = makeNotificationCtor();
    const notifier = createStalenessNotifier({
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: dir,
      fetchFn: makeFetchOk(makeInfo({ available: false, latest: null })),
      Notification: ctor,
    });
    await notifier.pollOnce();
    expect(calls).toHaveLength(0);
  });

  it("fans the staleness info out to onStaleness regardless of availability", async () => {
    const dir = await makeDir();
    const observed: StalenessInfo[] = [];
    const notifier = createStalenessNotifier({
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: dir,
      fetchFn: makeFetchOk(makeInfo({ available: false, latest: null })),
      Notification: makeNotificationCtor().ctor,
      onStaleness: (info) => observed.push(info),
    });
    await notifier.pollOnce();
    expect(observed).toHaveLength(1);
    expect(observed[0]?.current).toBe("0.1.40");
  });

  it("swallows fetch failures without crashing", async () => {
    const dir = await makeDir();
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const notifier = createStalenessNotifier({
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: dir,
      fetchFn,
      Notification: makeNotificationCtor().ctor,
    });
    await expect(notifier.pollOnce()).resolves.toBeUndefined();
  });

  it("wires the click handler to deps.onClick", async () => {
    const dir = await makeDir();
    const { ctor, calls } = makeNotificationCtor();
    const onClick = vi.fn();
    const notifier = createStalenessNotifier({
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: dir,
      fetchFn: makeFetchOk(makeInfo()),
      Notification: ctor,
      onClick,
    });
    await notifier.pollOnce();
    expect(calls[0]?.instance.clickHandlers).toHaveLength(1);
    calls[0]?.instance.clickHandlers[0]?.();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("skips notification when Notification ctor is null but still persists", async () => {
    const dir = await makeDir();
    const notifier = createStalenessNotifier({
      serverUrl: "http://127.0.0.1:8088/",
      userDataDir: dir,
      fetchFn: makeFetchOk(makeInfo()),
      Notification: null,
    });
    await notifier.pollOnce();
    const persisted = await readNotifiedFile(dir);
    expect(persisted.has("0.1.41")).toBe(true);
  });
});
