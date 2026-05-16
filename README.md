# nimbus-desktop

Native desktop shell for the [Nimbus](https://github.com/nimbus/nimbus)
operator console.

`nimbus-desktop` is a signed, notarized, auto-updating Electron
application that wraps the operator console UI served by a local
`nimbus` instance. It is **separate from `nimbus/nimbus`** by design
so the desktop release cadence, packaging matrix, and signing
credentials stay isolated from the core server.

## Install

| Platform | Download                                         | Notes                                                   |
| -------- | ------------------------------------------------ | ------------------------------------------------------- |
| macOS    | `nimbus-desktop-<version>-universal.dmg`         | Universal binary (arm64 + x64), notarized.              |
| Linux    | `nimbus-desktop-<version>-x86_64.AppImage`        | Self-contained. `chmod +x` and run.                      |
|          | `nimbus-desktop_<version>_amd64.deb`              | Debian / Ubuntu: `sudo apt install ./*.deb`              |
|          | `nimbus-desktop-<version>.x86_64.rpm`              | Fedora / RHEL: `sudo dnf install ./*.rpm`                 |
| Windows  | _(deferred — Azure Trusted Signing onboarding pending; see [decision 002](./docs/decisions/002-windows-code-signing.md))_ |

Latest releases live at
[github.com/nimbus/desktop/releases](https://github.com/nimbus/desktop/releases).

`nimbus-desktop` does **not** ship a Nimbus server. Install
[`nimbus`](https://github.com/nimbus/nimbus) separately — the shell
discovers a running instance on launch.

## Launch

```sh
# macOS
open -a nimbus-desktop

# Linux
nimbus-desktop

# Windows
"%LOCALAPPDATA%\Programs\nimbus-desktop\nimbus-desktop.exe"
```

On first launch the shell discovers a local `nimbus` instance via
`server.json` (see [File locations](#file-locations)). If none is
running, the shell spawns one in the background and waits for it to
become ready (~1-2 s). The window opens to the operator console at
`/ui/`.

## Update

Updates ship automatically via
[`electron-updater`](https://www.electron.build/auto-update) from
GitHub Releases. The shell polls on launch and at idle, downloads
in the background, and installs on the next operator-initiated quit
(never a forced restart). Signature verification is enforced
end-to-end; an update with a broken signature is rejected.

## Troubleshooting

### "No nimbus server discovered"

The shell could not find a running `nimbus`. Confirm:

```sh
nimbus --version            # is it installed?
nimbus start                # start it manually
ls ~/.config/nimbus/server.json  # was server.json written?
```

On macOS the discovery path is
`~/Library/Application Support/nimbus/server.json`. On Windows it is
`%APPDATA%\nimbus\server.json`.

### "Update download failed"

Re-launch the app. If it persists, check
`~/Library/Caches/nimbus-desktop-updater/` (macOS),
`~/.cache/nimbus-desktop-updater/` (Linux), or
`%LOCALAPPDATA%\nimbus-desktop-updater\` (Windows) — clearing this
directory forces a fresh download. The shell will fall through to a
manual-download notification if the auto-update path keeps failing.

### Renderer is blank

Open the developer Help → "Toggle DevTools" entry (production builds
include DevTools but log only). If the console shows
`net::ERR_CONNECTION_REFUSED`, `nimbus` is not running on the
discovered address. Restart with `nimbus start`.

## File locations

| Resource                | macOS                                                                            | Linux                                                | Windows                                                          |
| ----------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| App settings            | `~/Library/Application Support/nimbus-desktop/`                                  | `~/.config/nimbus-desktop/`                          | `%APPDATA%\nimbus-desktop\`                                       |
| Logs                    | `~/Library/Logs/nimbus-desktop/`                                                  | `~/.config/nimbus-desktop/logs/`                     | `%APPDATA%\nimbus-desktop\logs\`                                  |
| Updater cache           | `~/Library/Caches/nimbus-desktop-updater/`                                       | `~/.cache/nimbus-desktop-updater/`                   | `%LOCALAPPDATA%\nimbus-desktop-updater\`                          |
| `server.json` discovery | `~/Library/Application Support/nimbus/server.json` (read-only — owned by nimbus) | `~/.config/nimbus/server.json` (read-only)           | `%APPDATA%\nimbus\server.json` (read-only)                        |

## Uninstall

| macOS   | Drag `nimbus-desktop.app` to Trash. Remove `~/Library/Application Support/nimbus-desktop/`, `~/Library/Logs/nimbus-desktop/`, `~/Library/Caches/nimbus-desktop-updater/`. |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux   | `sudo apt remove nimbus-desktop` (deb) or `sudo dnf remove nimbus-desktop` (rpm). AppImage: delete the file. Remove `~/.config/nimbus-desktop/` and `~/.cache/nimbus-desktop-updater/`. |
| Windows | Settings → Apps → nimbus-desktop → Uninstall. Remove `%APPDATA%\nimbus-desktop\` and `%LOCALAPPDATA%\nimbus-desktop-updater\`.                                            |

Removing `nimbus-desktop` does **not** remove `nimbus` itself. Uninstall
`nimbus` via its own [install script](https://github.com/nimbus/nimbus#install)
if you want to clean up the server too.

## Security posture

See [`docs/security-posture.md`](./docs/security-posture.md) for the
reviewable summary of how the shell isolates the renderer, locks
down Electron Fuses, and signs releases. No telemetry is sent by
default. The renderer is sandboxed, context-isolated, and has
`nodeIntegration: false`.

## Development

This repo is a Phase 2 deliverable of the desktop initiative.
The roadmap lives at
[`docs/plans/desktop-shell-plan.md`](https://github.com/nimbus/nimbus/blob/main/docs/plans/desktop-shell-plan.md)
in `nimbus/nimbus`.

Stack:

- Electron 42, electron-builder 26, electron-updater 6
- TypeScript 6 strict, Biome 2.4
- Vitest (unit), Playwright (packaged-shell E2E)

```sh
npm ci
npm run dev              # build main + launch
npm run test             # vitest unit tests
npm run package          # local unsigned package (verifies wiring)
npm run package:mac      # signed if Developer ID is in keychain
```

Releases are cut by tagging `v*` on `main`; the CI workflow in
[`.github/workflows/release.yml`](./.github/workflows/release.yml)
produces signed installers and publishes them. See
[`docs/release-runbook.md`](./docs/release-runbook.md) for the
release process and credential rotation.

## Decisions

External decisions for signing, notarization, and update hosting
live in [`docs/decisions/`](./docs/decisions/):

- [001 — Apple signing and notarization](./docs/decisions/001-apple-signing-and-notarization.md)
- [002 — Windows code signing](./docs/decisions/002-windows-code-signing.md)
- [003 — Auto-update channel](./docs/decisions/003-auto-update-channel.md)

## License

Same as `nimbus/nimbus`. See the parent repo for license details.
