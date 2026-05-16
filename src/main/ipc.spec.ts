import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";

import { createIpcRouter, IpcOriginRejection } from "./ipc.js";

interface CapturedHandle {
  channel: string;
  fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
}

function buildFakeIpc(): {
  ipc: Pick<IpcMain, "handle">;
  captured: CapturedHandle[];
} {
  const captured: CapturedHandle[] = [];
  return {
    captured,
    ipc: {
      handle: (channel, fn) => {
        captured.push({
          channel,
          fn: fn as CapturedHandle["fn"],
        });
      },
    } as Pick<IpcMain, "handle">,
  };
}

function fakeEvent(senderUrl: string | null): IpcMainInvokeEvent {
  return {
    senderFrame: senderUrl === null ? null : { url: senderUrl },
  } as unknown as IpcMainInvokeEvent;
}

const ALLOWED = "http://127.0.0.1:8088/ui/";

describe("createIpcRouter", () => {
  it("registers a handler on the underlying ipcMain", () => {
    const { ipc, captured } = buildFakeIpc();
    const router = createIpcRouter({ allowedOrigin: ALLOWED, ipc });
    router.register("ping", () => "pong");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.channel).toBe("ping");
  });

  it("invokes the handler with the payload when senderFrame matches the allowed origin", async () => {
    const { ipc, captured } = buildFakeIpc();
    const handler = vi.fn().mockReturnValue("hello");
    const router = createIpcRouter({ allowedOrigin: ALLOWED, ipc });
    router.register("ping", handler);
    const event = fakeEvent("http://127.0.0.1:8088/ui/auth");
    const result = await captured[0]?.fn(event, "payload");
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event, "payload");
    expect(result).toBe("hello");
  });

  it("rejects with IpcOriginRejection when senderFrame is from a foreign origin", async () => {
    const { ipc, captured } = buildFakeIpc();
    const handler = vi.fn();
    const logged: string[] = [];
    const router = createIpcRouter({
      allowedOrigin: ALLOWED,
      ipc,
      logger: (msg) => logged.push(msg),
    });
    router.register("ping", handler);
    const event = fakeEvent("https://evil.example/");
    await expect(captured[0]?.fn(event, "payload")).rejects.toBeInstanceOf(
      IpcOriginRejection,
    );
    expect(handler).not.toHaveBeenCalled();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("ping");
    expect(logged[0]).toContain("evil.example");
  });

  it("rejects when senderFrame is null (no detached frames allowed)", async () => {
    const { ipc, captured } = buildFakeIpc();
    const handler = vi.fn();
    const router = createIpcRouter({ allowedOrigin: ALLOWED, ipc });
    router.register("ping", handler);
    const event = fakeEvent(null);
    await expect(captured[0]?.fn(event, undefined)).rejects.toBeInstanceOf(
      IpcOriginRejection,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects when allowedOrigin is malformed (URL parse failure is closed-fail)", async () => {
    const { ipc, captured } = buildFakeIpc();
    const handler = vi.fn();
    const router = createIpcRouter({ allowedOrigin: "not-a-url", ipc });
    router.register("ping", handler);
    const event = fakeEvent("http://127.0.0.1:8088/ui/");
    await expect(captured[0]?.fn(event, undefined)).rejects.toBeInstanceOf(
      IpcOriginRejection,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("surfaces the failing channel name on the rejection", async () => {
    const { ipc, captured } = buildFakeIpc();
    const router = createIpcRouter({ allowedOrigin: ALLOWED, ipc });
    router.register("system:probe", () => 0);
    const event = fakeEvent("https://evil.example/");
    try {
      await captured[0]?.fn(event, undefined);
      expect.fail("expected IpcOriginRejection");
    } catch (error) {
      expect(error).toBeInstanceOf(IpcOriginRejection);
      const rejection = error as IpcOriginRejection;
      expect(rejection.channel).toBe("system:probe");
      expect(rejection.senderUrl).toBe("https://evil.example/");
    }
  });
});
