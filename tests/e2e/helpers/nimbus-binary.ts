import { promises as fs } from "node:fs";
import path from "node:path";

// DS7 binary-resolution helper. CI passes the path to a pre-built
// nimbus binary via NIMBUS_DESKTOP_NIMBUS_BIN (the same env override
// the shell honours via src/main/server.ts::resolveNimbusExecutable).
//
// Locally, fall back to a sibling Cargo checkout — that's the
// developer-loop ergonomic: clone `nimbus/nimbus` next to
// `nimbus/desktop`, `cargo build`, then `npm run test:e2e` here picks
// up the freshly-built binary without any extra env wiring.

const LOCAL_FALLBACK_RELATIVE = [
  // sibling repo: ~/src/github.com/nimbus/nimbus, alongside this
  // ~/src/github.com/nimbus/desktop checkout (`here` is REPO_ROOT).
  ["..", "nimbus", "target", "release", "nimbus"],
  ["..", "nimbus", "target", "debug", "nimbus"],
] as const;

export async function resolveTestNimbusBinary(here: string): Promise<string> {
  const override = process.env.NIMBUS_DESKTOP_NIMBUS_BIN;
  if (override && override.length > 0) {
    if (await canExecute(override)) return override;
    throw new Error(
      `NIMBUS_DESKTOP_NIMBUS_BIN=${override} is set but the path is not executable`,
    );
  }
  for (const segments of LOCAL_FALLBACK_RELATIVE) {
    const candidate = path.resolve(here, ...segments);
    if (await canExecute(candidate)) return candidate;
  }
  throw new Error(
    "Could not find a nimbus binary for E2E. Set NIMBUS_DESKTOP_NIMBUS_BIN to a packaged nimbus binary, or build one at ../nimbus/target/release/nimbus.",
  );
}

async function canExecute(filePath: string): Promise<boolean> {
  try {
    // 1 = X_OK
    await fs.access(filePath, 1);
    return true;
  } catch {
    return false;
  }
}
