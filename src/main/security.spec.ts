import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyToWebContents,
  installSecurityRestrictions,
  isAllowedOrigin,
} from "./security.js";

interface FakeWebContents {
  readonly session: {
    setPermissionRequestHandler: ReturnType<typeof vi.fn>;
  };
  readonly on: ReturnType<typeof vi.fn>;
  readonly setWindowOpenHandler: ReturnType<typeof vi.fn>;
}

interface FakeApp {
  readonly on: ReturnType<typeof vi.fn>;
}

function makeFakeWebContents(): FakeWebContents {
  return {
    session: { setPermissionRequestHandler: vi.fn() },
    on: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
}

function makeFakeApp(): FakeApp {
  return { on: vi.fn() };
}

describe("isAllowedOrigin", () => {
  it("accepts identical-origin URLs", () => {
    expect(
      isAllowedOrigin("https://example.org/path", "https://example.org/"),
    ).toBe(true);
  });

  it("rejects cross-origin URLs", () => {
    expect(
      isAllowedOrigin("https://evil.example/", "https://example.org/"),
    ).toBe(false);
  });

  it("returns false for malformed URLs instead of throwing", () => {
    expect(isAllowedOrigin("not-a-url", "https://example.org/")).toBe(false);
  });

  it("respects port differences", () => {
    expect(
      isAllowedOrigin("http://127.0.0.1:8080/ui/", "http://127.0.0.1:9090/ui/"),
    ).toBe(false);
  });
});

describe("applyToWebContents", () => {
  let wc: FakeWebContents;

  beforeEach(() => {
    wc = makeFakeWebContents();
    applyToWebContents(
      wc as unknown as Parameters<typeof applyToWebContents>[0],
      {
        allowedOrigin: "https://example.org/",
      },
    );
  });

  it("registers a permission request handler", () => {
    expect(wc.session.setPermissionRequestHandler).toHaveBeenCalledOnce();
  });

  it("allows clipboard-read but denies geolocation", () => {
    const handler = wc.session.setPermissionRequestHandler.mock.calls[0][0] as (
      _wc: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void;

    const clipboard = vi.fn();
    handler({}, "clipboard-read", clipboard);
    expect(clipboard).toHaveBeenCalledWith(true);

    const geo = vi.fn();
    handler({}, "geolocation", geo);
    expect(geo).toHaveBeenCalledWith(false);
  });

  it("registers a will-navigate handler that blocks foreign origins", () => {
    const willNavigate = wc.on.mock.calls.find(
      (c: unknown[]) => c[0] === "will-navigate",
    );
    expect(willNavigate).toBeDefined();
    const handler = willNavigate?.[1] as (
      event: { preventDefault: () => void },
      url: string,
    ) => void;
    const event = { preventDefault: vi.fn() };
    handler(event, "https://evil.example/");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("registers a will-navigate handler that allows same origin", () => {
    const handler = wc.on.mock.calls.find(
      (c: unknown[]) => c[0] === "will-navigate",
    )?.[1] as (event: { preventDefault: () => void }, url: string) => void;
    const event = { preventDefault: vi.fn() };
    handler(event, "https://example.org/other");
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("denies all window-open attempts", () => {
    expect(wc.setWindowOpenHandler).toHaveBeenCalledOnce();
    const handler = wc.setWindowOpenHandler.mock.calls[0][0] as () => {
      action: string;
    };
    expect(handler()).toEqual({ action: "deny" });
  });
});

describe("installSecurityRestrictions", () => {
  it("subscribes to app.web-contents-created", () => {
    const app = makeFakeApp();
    installSecurityRestrictions(
      app as unknown as Parameters<typeof installSecurityRestrictions>[0],
      { allowedOrigin: "https://example.org/" },
    );
    expect(app.on).toHaveBeenCalledWith(
      "web-contents-created",
      expect.any(Function),
    );
  });

  it("wires every newly-created WebContents through applyToWebContents", () => {
    const app = makeFakeApp();
    installSecurityRestrictions(
      app as unknown as Parameters<typeof installSecurityRestrictions>[0],
      { allowedOrigin: "https://example.org/" },
    );
    const cb = app.on.mock.calls[0][1] as (
      _event: unknown,
      contents: FakeWebContents,
    ) => void;
    const wc = makeFakeWebContents();
    cb({}, wc);
    expect(wc.session.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(wc.setWindowOpenHandler).toHaveBeenCalledOnce();
  });
});
