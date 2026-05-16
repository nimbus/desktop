# 003 — Auto-update channel

- **Status:** accepted (DS0A)
- **Date:** 2026-05-15
- **Decision owner:** `nimbus/desktop` maintainers
- **Parent plan:** `nimbus/nimbus:docs/plans/desktop-shell-plan.md` → DS0A

## Context

`electron-updater` 6.8.x supports several update providers. For
`nimbus/desktop` the realistic choices are:

1. **GitHub Releases** (`provider: github`) — release artifacts hosted
   as GitHub Release assets. electron-updater polls
   `https://api.github.com/repos/<owner>/<repo>/releases/latest`. Works
   out-of-the-box with `electron-builder publish: github`; integrates
   with our existing release tooling; free for public repos.
2. **Self-hosted static channel** (`provider: generic`) — artifacts
   uploaded to Cloudflare R2 / Amazon S3 / Backblaze B2 behind a CDN.
   electron-updater fetches a `latest.yml` from a fixed URL. Required
   for private channels (internal-only beta) or if asset size exceeds
   GitHub's 2 GB per-release-asset cap (Electron app builds are
   typically 100–250 MB so this is not yet a constraint).

## Decision

Use **GitHub Releases** (`provider: github`).

`electron-builder.yml` configuration shape:

```yaml
publish:
  - provider: github
    owner: nimbus
    repo: desktop
    releaseType: release
```

`electron-updater` configuration in main process (DS5):

```ts
import { autoUpdater } from "electron-updater";
autoUpdater.setFeedURL({ provider: "github", owner: "nimbus", repo: "desktop" });
autoUpdater.checkForUpdatesAndNotify();
```

Differential updates (`blockmap` files) are produced by electron-builder
and uploaded automatically as release assets. The release workflow tags
GitHub releases as `draft` until DS9's release CI flips them to
`published` once signing, notarization, and smoke tests succeed.

## Fallback

**Self-hosted generic channel** (`provider: generic` against R2/S3) is
the contingency if:

- GitHub release asset size limit is reached (only relevant if any
  single platform artifact exceeds 2 GB).
- A private update channel is required (e.g. internal beta channel
  distributed only to employees — generic provider can sit behind an
  authenticated CDN edge).
- GitHub Releases availability becomes an operational concern (unlikely
  at our scale).

The fallback requires a `latest.yml` + artifact upload step in the
release workflow and a fixed `https://updates.nimbus.dev/<channel>/`
URL routed through Cloudflare R2 + Cloudflare Workers for the
authenticated case. Not implemented in DS0A.

## Rejected alternatives

- **Bintray / JFrog / Spaces** — none offer meaningful advantages over
  GitHub Releases at this scale.
- **In-app self-built update server** — operational overhead with no
  benefit for a side-by-side signed Electron app.

## Secret names (GitHub Actions secrets on `nimbus/desktop`)

| Name | Purpose |
| --- | --- |
| `DESKTOP_GH_RELEASE_TOKEN` | GitHub PAT (or GHA `GITHUB_TOKEN` with `contents: write` permission) used by `electron-builder publish` to upload release assets |

For the generic-provider fallback (not active in DS0A):

| Name | Purpose |
| --- | --- |
| `DESKTOP_UPDATE_BUCKET_ENDPOINT` | R2/S3 endpoint URL |
| `DESKTOP_UPDATE_BUCKET_ACCESS_KEY` | Access key id |
| `DESKTOP_UPDATE_BUCKET_SECRET_KEY` | Secret access key |
| `DESKTOP_UPDATE_BUCKET_NAME` | Bucket name |

DS0B verifies the names of the active provider exist via `gh secret
list`; values are never echoed. If the generic fallback is later
activated, the corresponding row is added to DS0B at that time.

## Rotation

- **Rotation cadence:** `DESKTOP_GH_RELEASE_TOKEN` rotates every
  6 months if a fine-grained PAT is used. If the workflow consumes
  the default `GITHUB_TOKEN`, no rotation is required (GitHub manages
  the token's lifecycle per-run).
- **Rotation procedure:** regenerate the PAT in
  [GitHub → Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens),
  update via `gh secret set`, then test against a pre-release tag.
- **Rotation contact:** the `nimbus/desktop` release manager (recorded
  in the team's internal credentials registry; not committed here).

## Unresolved manual procurement

- Decision on whether the release workflow should use the default
  `GITHUB_TOKEN` (simpler, no rotation) or a dedicated fine-grained PAT
  scoped to `contents: write` on `nimbus/desktop` (better audit trail,
  rotation overhead). Default to `GITHUB_TOKEN` unless audit
  requirements push us to a dedicated PAT.
- For the generic fallback (only if activated later): Cloudflare R2
  account provisioning, bucket creation, and Worker-based authenticated
  edge routing for private channels.

These items must be completed by a human operator before DS0B can pass.
