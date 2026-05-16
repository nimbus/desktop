# Security posture

This document summarizes the security model of `nimbus-desktop`, the
Electron shell that wraps the Nimbus operator console. It is a
reviewable extract of the rules enforced in the parent
[`docs/plans/desktop-shell-plan.md`](https://github.com/nimbus/nimbus/blob/main/docs/plans/desktop-shell-plan.md)
Control Plan Rules + DS3 (security baseline) + DS8 (signing /
notarization). For data-path trust, the upstream reference is
`docs/architecture/server/auth-runtime-trust.md` in `nimbus/nimbus`.

## Shape of the shell

- The shell is a **consumer** of the same `/ui/*` HTTP surface a
  browser hits. It does not have a privileged data path.
- All business logic lives in the Rust server. IPC carries window
  chrome, tray, menus, server lifecycle, auto-update, and deep links
  only — never queries, mutations, or document access.
- The packaged shell does not embed a Nimbus binary. It discovers an
  installed `nimbus` from `$PATH` or the platform-canonical install
  location; if none is present, it surfaces an actionable error.

## Renderer isolation

- `sandbox: true`
- `contextIsolation: true`
- `nodeIntegration: false`
- These defaults are not weakened. The renderer talks to the main
  process through a single `contextBridge.exposeInMainWorld` surface
  defined in `src/preload/index.cts`.

## IPC surface

- Single preload, single bridge namespace (`window.nimbusShell`).
- `event.senderFrame.url` is validated on every IPC handler against
  the discovered server URL. Channels that do not validate are
  rejected at code review and at runtime.
- `will-navigate`, `setWindowOpenHandler`, and
  `setPermissionRequestHandler` deny by default. The only allowed
  permission is clipboard read/write (for the operator console's
  `CopyChip`).
- Hard cap: 40 IPC channels. If the surface exceeds 50 channels,
  `dts-for-context-bridge` codegen is adopted before merging.

## Electron Fuses (DS3)

Flipped at packaging time via `scripts/flip-fuses.cjs` and
`@electron/fuses`, enforced post-build by `scripts/prepublish-check.cjs`.

| Fuse                                          | Production value |
| --------------------------------------------- | ---------------- |
| `RunAsNode`                                   | `false`          |
| `EnableNodeOptionsEnvironmentVariable`        | `false`          |
| `EnableNodeCliInspectArguments`               | `false`          |
| `EnableCookieEncryption`                      | `true`           |
| `EnableEmbeddedAsarIntegrityValidation`       | `true`           |
| `OnlyLoadAppFromAsar`                         | `true`           |

Drift in any of these aborts the release pipeline before publishing.

## Content Security Policy

The renderer's CSP comes from the Rust server's middleware (shipped
in `nimbus/nimbus` DU1). The shell does **not** add a meta-CSP and
does **not** relax `script-src 'self'`.

## Code signing and notarization (DS8)

- **macOS:** Developer ID Application certificate (Apple Developer
  Program). `scripts/notarize.cjs` runs as electron-builder's
  `afterSign` hook, submits the `.app` to Apple's `notarytool`
  service via `@electron/notarize`, and waits for the ticket. The
  DMG is stapled by electron-builder's post-sign step. Authentication
  uses an App Store Connect API key (decision 001), not an app-specific
  password. Hardened Runtime is enabled with explicit entitlements for
  V8 JIT, unsigned executable memory, and outbound network.
- **Windows:** Azure Trusted Signing (decision 002) — currently
  **deferred**. The `scripts/sign-windows.cjs` hook is wired through
  electron-builder's `signtoolOptions.sign` but no-ops without the
  6 Trusted Signing env vars present. The first release ships
  macOS + Linux only. Windows installers are produced unsigned for
  internal smoke testing.
- **Linux:** unsigned per community convention. AppImage / deb / rpm
  shipped via the same `electron-builder` matrix.

The signing material (`.p8` API key, `.p12` Developer ID cert,
keystore passwords, Trusted Signing client secret) never lives in
the repository. All secrets are stored in GitHub Actions secrets and
sourced at release time only. See
[`docs/decisions/001-apple-signing-and-notarization.md`](./decisions/001-apple-signing-and-notarization.md)
and
[`docs/decisions/002-windows-code-signing.md`](./decisions/002-windows-code-signing.md).

## Auto-update (DS5)

- `electron-updater` polls GitHub Releases for `latest-*.yml`
  manifests (decision 003).
- **Signature verification is never disabled.** The updater
  controller asserts `disableSignatureVerification` is not set and
  refuses to start if a prior caller has flipped it on.
- `autoDownload: true`, `autoInstallOnAppQuit: true` — operator-
  initiated quit installs the staged update; we never force a
  restart.

## Telemetry

**None by default.** Opt-in only if and when telemetry ships. No
crash reports, no usage events, no install pings are sent in the
default configuration.

## File locations

Per-platform locations the shell writes to:

| Resource                | macOS                                                                            | Linux                                                | Windows                                                          |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| App settings (Electron) | `~/Library/Application Support/nimbus-desktop/`                                   | `~/.config/nimbus-desktop/`                          | `%APPDATA%\nimbus-desktop\`                                       |
| Updater cache           | `~/Library/Caches/nimbus-desktop-updater/`                                       | `~/.cache/nimbus-desktop-updater/`                   | `%LOCALAPPDATA%\nimbus-desktop-updater\`                          |
| Server discovery        | `~/Library/Application Support/nimbus/server.json` (read-only — owned by nimbus) | `~/.config/nimbus/server.json` (read-only)           | `%APPDATA%\nimbus\server.json` (read-only)                        |

The shell **reads** `server.json` to discover the nimbus instance; it
never writes there. Server-side state is owned by `nimbus/nimbus`.

## Pre-launch posture

This is a pre-launch project. There are no production users yet.

- Breaking changes are preferred over compatibility shims.
- No deprecated IPC channels remain in the codebase.
- No legacy feature flags or migration paths exist.
