// DS0A scaffold-only test. The real unit + E2E surfaces land in DS1 and
// DS7. This file exists to prove the vitest + biome + tsc toolchain is
// wired before DS1 grows real coverage.

import { describe, expect, it } from "vitest";

import { describeDesktopBuild, desktopBuildId } from "../src/main/index.ts";

describe("ds0a scaffold", () => {
  it("exports a stable build id", () => {
    expect(desktopBuildId).toBe("ds0a-placeholder");
  });

  it("renders a descriptive build string", () => {
    expect(describeDesktopBuild()).toContain(desktopBuildId);
  });
});
