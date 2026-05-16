import { app } from "electron";

import { installSecurityRestrictions } from "./security.js";
import { createMainWindow, defaultPreloadPath } from "./window.js";

// DS1 hello-electron loop. The renderer points at a hardcoded HTTPS
// placeholder so the security baseline (sandbox + contextIsolation +
// permission/navigation/window-open handlers) is exercised before
// DS2 wires the real `nimbus start` discovery + spawn path.
export const PLACEHOLDER_URL = "https://example.org/";

export async function main(): Promise<void> {
  await app.whenReady();
  installSecurityRestrictions(app, { allowedOrigin: PLACEHOLDER_URL });
  createMainWindow({
    url: PLACEHOLDER_URL,
    preloadPath: defaultPreloadPath(),
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

// vitest sets process.env.VITEST automatically. The explicit
// `NIMBUS_DESKTOP_SKIP_AUTORUN=1` override exists for the rare case
// where a developer imports this module from a non-vitest harness
// for inspection.
const isUnderTest =
  process.env.VITEST !== undefined ||
  process.env.NIMBUS_DESKTOP_SKIP_AUTORUN === "1";

if (!isUnderTest) {
  void main();
}
