import { promises as fs } from "node:fs";
import path from "node:path";

// DS4 contract: persist BrowserWindow bounds across relaunches.
// Stored at `<userData>/window-state.json` per the plan. Schema is
// intentionally minimal — just the rectangle. A malformed or missing
// file means "use the DS1 defaults"; we never throw on load.

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const FILE_NAME = "window-state.json";

const MIN_WIDTH = 480;
const MIN_HEIGHT = 320;
const MAX_DIMENSION = 16_384;

export function windowStatePath(userDataDir: string): string {
  return path.join(userDataDir, FILE_NAME);
}

export async function loadWindowState(
  userDataDir: string,
): Promise<WindowBounds | null> {
  const target = windowStatePath(userDataDir);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlausibleBounds(parsed)) {
    return null;
  }
  return {
    x: parsed.x,
    y: parsed.y,
    width: parsed.width,
    height: parsed.height,
  };
}

export async function saveWindowState(
  userDataDir: string,
  bounds: WindowBounds,
): Promise<void> {
  if (!isPlausibleBounds(bounds)) {
    return;
  }
  await fs.mkdir(userDataDir, { recursive: true });
  const target = windowStatePath(userDataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(bounds), "utf8");
  await fs.rename(tmp, target);
}

function isPlausibleBounds(value: unknown): value is WindowBounds {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  for (const key of ["x", "y", "width", "height"] as const) {
    const n = v[key];
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
  }
  const b = v as unknown as WindowBounds;
  if (b.width < MIN_WIDTH || b.width > MAX_DIMENSION) return false;
  if (b.height < MIN_HEIGHT || b.height > MAX_DIMENSION) return false;
  if (Math.abs(b.x) > MAX_DIMENSION) return false;
  if (Math.abs(b.y) > MAX_DIMENSION) return false;
  return true;
}
