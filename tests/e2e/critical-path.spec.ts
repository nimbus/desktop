import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, expect, test } from "@playwright/test";

import { findPackagedShell } from "./helpers/find-shell.js";
import {
  launchPackagedShell,
  type ShellHandle,
} from "./helpers/launch-shell.js";
import { resolveTestNimbusBinary } from "./helpers/nimbus-binary.js";
import {
  createScratchEnv,
  disposeScratchEnv,
  type ScratchEnv,
} from "./helpers/scratch-env.js";
import {
  type NimbusServer,
  spawnNimbusServer,
} from "./helpers/spawn-nimbus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");

// DS7 critical-path E2E. The packaged shell, talking to a real
// `nimbus start`, must:
//   1. Reach `http://127.0.0.1:<port>/ui/auth` (or `/ui/` redirect).
//   2. Serve a CSP header with `script-src 'self'`.
//   3. Render the auth form (auth-token input).
//   4. Accept a valid token via POST /ui/auth/session.
//   5. Render the overview with the first-run onboarding.
//   6. Open the ⌘K command palette.
//   7. Open the ⌘\ system tenant lens.

test.describe("DS7 critical path", () => {
  let scratch: ScratchEnv;
  let server: NimbusServer;
  let shell: ShellHandle;

  test.beforeAll(async () => {
    const nimbusBinary = await resolveTestNimbusBinary(REPO_ROOT);
    const shellBinary = await findPackagedShell(REPO_ROOT);
    scratch = createScratchEnv();
    server = await spawnNimbusServer(nimbusBinary, scratch);
    shell = await launchPackagedShell({
      binary: shellBinary,
      scratch,
    });
  });

  test.afterAll(async () => {
    if (shell) await shell.shutdown();
    if (server) await server.shutdown();
    if (scratch) disposeScratchEnv(scratch);
  });

  test("CSP header pins script-src 'self'", async ({ request }) => {
    const res = await request.get(`${server.baseURL}/ui/`);
    expect(res.status()).toBe(200);
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
  });

  test("auth form renders and a valid token is accepted", async ({
    request,
  }) => {
    const browser = await chromium.connectOverCDP(shell.cdpHttpEndpoint);
    try {
      const context = browser.contexts()[0];
      expect(context).toBeDefined();
      const page = context.pages()[0] ?? (await context.waitForEvent("page"));
      await page.waitForLoadState("domcontentloaded");
      expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/ui\//);
      await expect(
        page.getByRole("main", { name: "Sign in to Nimbus" }),
      ).toBeVisible();
      await expect(
        page.getByRole("form", { name: "Auth token sign in" }),
      ).toBeVisible();
      await expect(
        page.getByRole("textbox", { name: "Enter auth token" }),
      ).toBeVisible();
    } finally {
      // `connectOverCDP` opens an extra ws connection. Closing the
      // Browser handle here detaches the test from the running shell
      // without killing it — leave shutdown to afterAll.
      await browser.close();
    }

    const token = server.readToken();
    const res = await request.post(`${server.baseURL}/ui/auth/session`, {
      data: { token },
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("overview renders the first-run onboarding after auth", async () => {
    const token = server.readToken();
    const browser = await chromium.connectOverCDP(shell.cdpHttpEndpoint);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.waitForEvent("page"));
      // Drive auth via fetch from within the renderer context so the
      // session cookie is bound to its origin. Using Playwright's own
      // `request` fixture would write to a different cookie jar.
      const ok = await page.evaluate(async (t) => {
        const r = await fetch("/ui/auth/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: t }),
        });
        return r.ok;
      }, token);
      expect(ok).toBe(true);
      await page.goto(`${server.baseURL}/ui/`);
      await expect(page.getByTestId("page-overview")).toBeVisible();
      // The headline reads the live status and inventory queries, so this
      // sentence proves the session reached the server and it reported
      // healthy with nothing deployed.
      await expect(page.getByTestId("overview-sentence")).toHaveText(
        "The server is up and waiting for its first app.",
      );
      // An empty scratch server shows the first-run onboarding in place of
      // the stats row and the recent runs table.
      await expect(page.getByTestId("overview-onboarding")).toBeVisible();
      await expect(page.getByTestId("overview-onboarding-title")).toHaveText(
        "Nothing here yet",
      );
      for (const step of ["install", "dev", "run"]) {
        await expect(
          page.getByTestId(`overview-onboarding-step-${step}`),
        ).toHaveAttribute("data-done", "false");
      }
      await expect(page.getByTestId("overview-connect")).toBeVisible();
      await expect(page.getByTestId("overview-stats")).toHaveCount(0);

      // ⌘K palette + ⌘\ tenant lens. Accelerators are routed through
      // Electron's menu (DS4) AND a renderer-side keydown handler,
      // so a `page.keyboard.press` is the right hook regardless of
      // platform — the renderer treats Cmd and Ctrl interchangeably.
      const mod = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${mod}+KeyK`);
      await expect(page.getByTestId("command-palette")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("command-palette")).toBeHidden();

      await page.keyboard.press(`${mod}+Backslash`);
      await expect(page.getByTestId("system-tenant-lens")).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
