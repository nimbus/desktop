import { promises as fs } from "node:fs";
import path from "node:path";

// DS7 packaged-shell binary locator. electron-builder writes the
// platform-specific layout under release/ — see DS6's manifest:
//   release/mac-universal/nimbus-desktop.app/Contents/MacOS/nimbus-desktop
//   release/win-unpacked/nimbus-desktop.exe (if --dir) or release/*.exe
//   release/linux-unpacked/nimbus-desktop
//
// We never spelunk an asar mount or invoke `open` — the spec needs
// stdout (where Chromium prints the CDP endpoint) so it must own the
// child process directly.

const RELEASE = "release";
const PRODUCT_DARWIN = "nimbus-desktop";

export async function findPackagedShell(repoRoot: string): Promise<string> {
  const override = process.env.NIMBUS_DESKTOP_SHELL_BIN;
  if (override && override.length > 0) {
    if (await canExecute(override)) return override;
    throw new Error(
      `NIMBUS_DESKTOP_SHELL_BIN=${override} is set but the path is not executable`,
    );
  }
  const platform = process.platform;
  const candidates: string[] = [];
  if (platform === "darwin") {
    // mac-universal is the merged binary the DS6 packaging step emits.
    // mac-arm64 / mac-x64 are the per-arch artifacts on the side.
    for (const dir of ["mac-universal", "mac-arm64", "mac-x64"]) {
      candidates.push(
        path.join(
          repoRoot,
          RELEASE,
          dir,
          `${PRODUCT_DARWIN}.app`,
          "Contents",
          "MacOS",
          PRODUCT_DARWIN,
        ),
      );
    }
  } else if (platform === "win32") {
    candidates.push(
      path.join(repoRoot, RELEASE, "win-unpacked", "nimbus-desktop.exe"),
    );
  } else {
    candidates.push(
      path.join(repoRoot, RELEASE, "linux-unpacked", "nimbus-desktop"),
    );
  }
  for (const candidate of candidates) {
    if (await canExecute(candidate)) return candidate;
  }
  throw new Error(
    `Could not find a packaged shell binary. Run \`npm run package\` first. Looked at: ${candidates.join(", ")}.`,
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
