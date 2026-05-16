import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadWindowState,
  saveWindowState,
  windowStatePath,
} from "./window-state.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "nimbus-ds4-state-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("loadWindowState", () => {
  it("returns null when the file does not exist", async () => {
    const result = await loadWindowState(dir);
    expect(result).toBeNull();
  });

  it("returns null when the file is malformed JSON", async () => {
    await fs.writeFile(windowStatePath(dir), "{ not json");
    const result = await loadWindowState(dir);
    expect(result).toBeNull();
  });

  it("returns null when a required field is missing", async () => {
    await fs.writeFile(
      windowStatePath(dir),
      JSON.stringify({ x: 0, y: 0, width: 1280 }),
    );
    const result = await loadWindowState(dir);
    expect(result).toBeNull();
  });

  it("returns null when width is below the minimum", async () => {
    await fs.writeFile(
      windowStatePath(dir),
      JSON.stringify({ x: 0, y: 0, width: 10, height: 600 }),
    );
    const result = await loadWindowState(dir);
    expect(result).toBeNull();
  });

  it("returns parsed bounds for a well-formed file", async () => {
    await fs.writeFile(
      windowStatePath(dir),
      JSON.stringify({ x: 42, y: 84, width: 1024, height: 768 }),
    );
    const result = await loadWindowState(dir);
    expect(result).toEqual({ x: 42, y: 84, width: 1024, height: 768 });
  });
});

describe("saveWindowState", () => {
  it("writes bounds that round-trip through loadWindowState", async () => {
    const bounds = { x: 100, y: 200, width: 1280, height: 800 };
    await saveWindowState(dir, bounds);
    const loaded = await loadWindowState(dir);
    expect(loaded).toEqual(bounds);
  });

  it("creates the userData dir if missing", async () => {
    const nested = path.join(dir, "nested", "user");
    await saveWindowState(nested, { x: 0, y: 0, width: 1280, height: 800 });
    const stat = await fs.stat(windowStatePath(nested));
    expect(stat.isFile()).toBe(true);
  });

  it("does not write a file when bounds are implausible", async () => {
    await saveWindowState(dir, {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
    await expect(fs.access(windowStatePath(dir))).rejects.toThrowError();
  });

  it("overwrites prior state atomically", async () => {
    await saveWindowState(dir, { x: 0, y: 0, width: 1280, height: 800 });
    await saveWindowState(dir, { x: 50, y: 60, width: 1400, height: 900 });
    const loaded = await loadWindowState(dir);
    expect(loaded).toEqual({ x: 50, y: 60, width: 1400, height: 900 });
  });
});
