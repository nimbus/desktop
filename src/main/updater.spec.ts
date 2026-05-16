import { describe, expect, it, vi } from "vitest";

import {
  createUpdaterController,
  type ElectronUpdaterLike,
  type UpdaterStateListener,
} from "./updater.js";

interface FakeAutoUpdater extends ElectronUpdaterLike {
  emit(event: string, ...args: unknown[]): void;
  listenerCount(event: string): number;
}

function buildFakeAutoUpdater(): FakeAutoUpdater {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const get = (event: string) => {
    let bucket = listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      listeners.set(event, bucket);
    }
    return bucket;
  };
  const fake: FakeAutoUpdater = {
    autoDownload: undefined,
    autoInstallOnAppQuit: undefined,
    on(event, handler) {
      get(event).add(handler);
      return this;
    },
    off(event, handler) {
      get(event).delete(handler);
      return this;
    },
    async checkForUpdates() {
      return null;
    },
    emit(event, ...args) {
      for (const fn of get(event)) {
        fn(...args);
      }
    },
    listenerCount(event) {
      return get(event).size;
    },
  };
  return fake;
}

function collect(): {
  onStateChange: UpdaterStateListener;
  events: ReturnType<
    UpdaterStateListener extends (c: infer T) => unknown ? () => T[] : never
  >;
  changes: import("../shared/ipc-types.js").UpdaterStateChange[];
} {
  const changes: import("../shared/ipc-types.js").UpdaterStateChange[] = [];
  const onStateChange: UpdaterStateListener = (change) => {
    changes.push(change);
  };
  return {
    onStateChange,
    events: changes as never,
    changes,
  };
}

describe("createUpdaterController", () => {
  it("pins autoDownload=true and autoInstallOnAppQuit=true", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange } = collect();
    createUpdaterController({ autoUpdater: fake, onStateChange });
    expect(fake.autoDownload).toBe(true);
    expect(fake.autoInstallOnAppQuit).toBe(true);
  });

  it("refuses to start when disableSignatureVerification is true", () => {
    const fake = buildFakeAutoUpdater() as FakeAutoUpdater & {
      disableSignatureVerification?: boolean;
    };
    fake.disableSignatureVerification = true;
    const { onStateChange } = collect();
    expect(() =>
      createUpdaterController({ autoUpdater: fake, onStateChange }),
    ).toThrow(/Signature verification is required/);
  });

  it("never assigns to disableSignatureVerification", () => {
    const fake = buildFakeAutoUpdater() as FakeAutoUpdater & {
      disableSignatureVerification?: unknown;
    };
    const { onStateChange } = collect();
    createUpdaterController({ autoUpdater: fake, onStateChange });
    // The field was never set by the controller. If a future change
    // introduces an assignment this assertion will start failing.
    expect("disableSignatureVerification" in fake).toBe(false);
  });

  it("registers exactly one listener per electron-updater event", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange } = collect();
    createUpdaterController({ autoUpdater: fake, onStateChange });
    for (const event of [
      "checking-for-update",
      "update-available",
      "update-not-available",
      "download-progress",
      "update-downloaded",
      "error",
    ]) {
      expect(fake.listenerCount(event)).toBe(1);
    }
  });

  it("maps checking-for-update to state=checking", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange, changes } = collect();
    createUpdaterController({ autoUpdater: fake, onStateChange });
    fake.emit("checking-for-update");
    expect(changes).toEqual([{ state: "checking" }]);
  });

  it("maps update-available with version + releaseNotes", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange, changes } = collect();
    createUpdaterController({ autoUpdater: fake, onStateChange });
    fake.emit("update-available", {
      version: "1.2.3",
      releaseNotes: "First release",
    });
    expect(changes).toEqual([
      {
        state: "available",
        version: "1.2.3",
        releaseNotes: "First release",
      },
    ]);
  });

  it("maps update-not-available with version", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange, changes } = collect();
    createUpdaterController({ autoUpdater: fake, onStateChange });
    fake.emit("update-not-available", { version: "1.2.3" });
    expect(changes).toEqual([{ state: "not-available", version: "1.2.3" }]);
  });

  it("maps download-progress to state=downloading with all 4 numeric fields", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange, changes } = collect();
    createUpdaterController({ autoUpdater: fake, onStateChange });
    fake.emit("download-progress", {
      bytesPerSecond: 1024,
      percent: 42.5,
      transferred: 1024 * 100,
      total: 1024 * 1024,
    });
    expect(changes).toEqual([
      {
        state: "downloading",
        progress: {
          bytesPerSecond: 1024,
          percent: 42.5,
          transferred: 102400,
          total: 1048576,
        },
      },
    ]);
  });

  it("coerces missing or non-finite numeric fields to 0", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange, changes } = collect();
    createUpdaterController({ autoUpdater: fake, onStateChange });
    fake.emit("download-progress", { bytesPerSecond: Number.NaN });
    expect(changes).toEqual([
      {
        state: "downloading",
        progress: {
          bytesPerSecond: 0,
          percent: 0,
          transferred: 0,
          total: 0,
        },
      },
    ]);
  });

  it("maps update-downloaded with version + releaseNotes", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange, changes } = collect();
    createUpdaterController({ autoUpdater: fake, onStateChange });
    fake.emit("update-downloaded", {
      version: "1.2.3",
      releaseNotes: "Bug fixes",
    });
    expect(changes).toEqual([
      {
        state: "downloaded",
        version: "1.2.3",
        releaseNotes: "Bug fixes",
      },
    ]);
  });

  it("maps error event with message", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange, changes } = collect();
    createUpdaterController({ autoUpdater: fake, onStateChange });
    fake.emit("error", new Error("feed unreachable"));
    expect(changes).toEqual([{ state: "error", message: "feed unreachable" }]);
  });

  it("delegates checkForUpdates to autoUpdater.checkForUpdates", async () => {
    const fake = buildFakeAutoUpdater();
    const checkSpy = vi.spyOn(fake, "checkForUpdates");
    const { onStateChange } = collect();
    const ctl = createUpdaterController({ autoUpdater: fake, onStateChange });
    await ctl.checkForUpdates();
    expect(checkSpy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a synchronous checkForUpdates throw as state=error", async () => {
    const fake = buildFakeAutoUpdater();
    fake.checkForUpdates = async () => {
      throw new Error("boom");
    };
    const { onStateChange, changes } = collect();
    const ctl = createUpdaterController({ autoUpdater: fake, onStateChange });
    await ctl.checkForUpdates();
    expect(changes).toEqual([{ state: "error", message: "boom" }]);
  });

  it("getState returns the last emitted change", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange } = collect();
    const ctl = createUpdaterController({ autoUpdater: fake, onStateChange });
    expect(ctl.getState()).toEqual({ state: "idle" });
    fake.emit("checking-for-update");
    expect(ctl.getState()).toEqual({ state: "checking" });
    fake.emit("update-available", { version: "9.9.9" });
    expect(ctl.getState()).toEqual({ state: "available", version: "9.9.9" });
  });

  it("destroy removes all listeners", () => {
    const fake = buildFakeAutoUpdater();
    const { onStateChange } = collect();
    const ctl = createUpdaterController({ autoUpdater: fake, onStateChange });
    ctl.destroy();
    for (const event of [
      "checking-for-update",
      "update-available",
      "update-not-available",
      "download-progress",
      "update-downloaded",
      "error",
    ]) {
      expect(fake.listenerCount(event)).toBe(0);
    }
  });

  it("swallows listener exceptions and logs to the supplied logger", () => {
    const fake = buildFakeAutoUpdater();
    const listenerError = vi.fn(() => {
      throw new Error("listener boom");
    });
    const logger = { error: vi.fn() };
    createUpdaterController({
      autoUpdater: fake,
      onStateChange: listenerError,
      logger,
    });
    expect(() => fake.emit("checking-for-update")).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      "updater onStateChange listener threw",
      expect.any(Error),
    );
  });
});
