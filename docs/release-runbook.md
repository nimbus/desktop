# Release runbook

This runbook covers how to cut a `nimbus-desktop` release, how to
rotate the signing credentials, and how to respond to a signing-cert
expiry. The CI workflow that implements it is
[`.github/workflows/release.yml`](../.github/workflows/release.yml)
(DS9).

## TL;DR

```sh
# 1. Bump the version in package.json (semver).
# 2. Commit + push.
# 3. Tag and push:
git tag v0.1.0
git push origin v0.1.0
```

The `release` workflow fires on the tag push, builds + signs +
notarizes installers on all three platform runners, and publishes
them to a GitHub Release.

## Tag conventions

| Tag                       | Behavior                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `v0.0.0-dryrun-N`         | Dry-run proof. Workflow runs end-to-end; produces a draft release the operator can inspect + delete.    |
| `v0.x.y` / `v1.x.y`+      | Real release. Publishes a non-draft GitHub Release with auto-update manifests; live electron-updater feed picks it up. |

## What the workflow does

For each platform runner:

1. Checkout + Node 22 + `npm ci` + lint + typecheck + unit tests.
2. **macOS only:** decode `DESKTOP_APPLE_CERT_P12` to a temp `.p12`,
   point electron-builder at it via `CSC_LINK` + `CSC_KEY_PASSWORD`.
   Decode `DESKTOP_APPLE_API_KEY` (base64 `.p8`) to a temp file and
   export `DESKTOP_APPLE_API_KEY_PATH` for `scripts/notarize.cjs`.
3. `electron-builder` packages → signs (`afterPack` flips fuses) →
   notarizes (`afterSign` runs notarize.cjs) → publishes via the
   `github` provider.
4. **macOS only:** post-flight verification —
   `codesign --verify --deep --strict`, `spctl --assess` (must
   report `accepted source=Notarized Developer ID`), and
   `xcrun stapler validate` against both the `.app` and the `.dmg`.
5. Installer size audit + artifact upload.

Windows packaging produces unsigned NSIS installers while decision 002
is `deferred`. Linux packaging produces unsigned AppImage / deb / rpm.

## Cutting a release

1. **Confirm tip-of-main is green.** Both `package.yml` and `e2e.yml`
   must be green on `main` for the SHA you're about to tag.
2. **Bump version.** Edit `package.json` to the target semver,
   commit, push.
3. **Tag.**
   ```sh
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin v0.1.0
   ```
4. **Watch the run.**
   ```sh
   gh run watch
   ```
   Expected wall-clock: ~20-30 min for the full matrix (macOS
   notarization round-trip is the long pole at 5-15 min).
5. **Verify the release.** Open the GitHub Release page and confirm:
   - DMG + ZIP (universal mac), AppImage + deb + rpm (linux), NSIS
     x64 + arm64 (windows) all attached.
   - `latest-mac.yml` and `latest-linux.yml` attached (auto-update
     manifests).
   - macOS post-flight log in the runner shows
     `spctl assess ... accepted source=Notarized Developer ID`.
6. **Rollback path:** if a regression surfaces post-release, mark the
   release `draft` in GitHub Releases — this pulls it from the
   auto-update feed without deleting artifacts. The previous release
   remains the latest stable for new installs.

## Dry-run before a real cut

For wiring changes (release.yml edits, new signing config, cert
rotation), prove the pipeline with a dry-run tag first:

```sh
git tag v0.0.0-dryrun-1
git push origin v0.0.0-dryrun-1
# inspect the draft release
gh release view v0.0.0-dryrun-1
# clean up
git tag -d v0.0.0-dryrun-1
git push --delete origin v0.0.0-dryrun-1
gh release delete v0.0.0-dryrun-1 --yes
```

## Credential rotation

Names only — values are never written to the repo, this runbook, or
chat transcripts. All values live in GitHub Actions secrets.

### Apple (12-month cadence)

The Apple Developer ID Application certificate expires every 5 years;
the App Store Connect API key has no fixed expiry but is rotated on
a 12-month cadence for hygiene. Rotation contact: original Apple
Developer Program enrollee.

To rotate:

1. In App Store Connect, create a new API key (download `.p8`).
2. `openssl base64 -A -in NewKey.p8 -out NewKey.p8.b64`
3. ```sh
   gh secret set DESKTOP_APPLE_API_KEY --repo nimbus/desktop < NewKey.p8.b64
   gh secret set DESKTOP_APPLE_API_KEY_ID --repo nimbus/desktop --body "<new key id>"
   gh secret set DESKTOP_APPLE_API_ISSUER --repo nimbus/desktop --body "<issuer uuid>"
   ```
4. Revoke the old key in App Store Connect.
5. Run a dry-run tag to confirm.

To rotate the Developer ID Application certificate:

1. Renew the certificate in the Apple Developer portal.
2. Export the new `.p12` from Keychain Access (include private key
   + intermediates + root).
3. ```sh
   openssl base64 -A -in NewCert.p12 -out NewCert.p12.b64
   gh secret set DESKTOP_APPLE_CERT_P12 --repo nimbus/desktop < NewCert.p12.b64
   gh secret set DESKTOP_APPLE_CERT_P12_PASSWORD --repo nimbus/desktop
   gh secret set DESKTOP_APPLE_SIGNING_IDENTITY --repo nimbus/desktop \
     --body "Developer ID Application: <Name> (<Team ID>)"
   ```
4. Dry-run tag to confirm new signature chain validates.

### Windows (Azure Trusted Signing — 6-month client secret cadence)

Not yet active (decision 002 deferred). When activated, the Azure
Service Principal client secret expires every 6 months by Azure
default policy. Rotation contact: Azure subscription owner.

```sh
# in the Azure portal, generate a new client secret for the SP
gh secret set DESKTOP_WINDOWS_TS_CLIENT_SECRET --repo nimbus/desktop
```

The tenant ID, client ID, endpoint, account name, and cert profile
do not change between rotations.

### GitHub release token

The release workflow uses the auto-provisioned `GITHUB_TOKEN` with
`contents: write` (decision 003). No rotation needed.

If audit policy requires a fine-grained PAT, set
`DESKTOP_GH_RELEASE_TOKEN` and update `electron-builder.yml`'s
`publish` provider config accordingly. Rotate every 6 months;
contact: `nimbus/desktop` release manager.

## Responding to a signing-cert expiry

If a release fails with `errSecCSResourcesNotSealed` or
`The signature of the binary is invalid` on a macOS runner:

1. Check the cert expiry in the Apple Developer portal.
2. If expired, follow the **Apple cert rotation** steps above.
3. While the new cert is being provisioned (can take a business
   day for Apple to issue), pause releases. Operators on the
   currently-published version are unaffected — the published
   `.app` ticket from notarization remains valid for the lifetime
   of the staple, independent of cert validity.
4. Once the new cert is in place, run a dry-run tag.

If a release fails with `notarytool: authentication failed`:

1. The App Store Connect API key was revoked or rotated out of band.
2. Generate a new key (steps above) and update the three Apple API
   secrets.

If a release fails with `Trusted Signing CLI: 401 Unauthorized`
(once decision 002 is active):

1. The Azure SP client secret expired.
2. Rotate per the Windows section above.

## Reference: secret matrix

The full list of secret names and what they're for lives in
`scripts/verify-secrets.sh`. Run:

```sh
npm run verify:secrets
```

to confirm all REQUIRED secret names are present. The script never
reads values — only names — and exits 0 when complete.
