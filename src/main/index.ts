// DS0A placeholder. The real Electron app entrypoint lands in DS1.
//
// This file exists so `tsc --noEmit` and `biome check` have something
// to verify during DS0A's scaffold gate. It is intentionally trivial:
// importing `electron` at runtime requires the Electron binary, which
// `npm ci` installs as a devDependency, but type resolution alone is
// enough to prove the toolchain is wired.

export const desktopBuildId = "ds0a-placeholder" as const;

export type DesktopBuildId = typeof desktopBuildId;

export function describeDesktopBuild(): string {
  return `nimbus/desktop scaffold (${desktopBuildId})`;
}
