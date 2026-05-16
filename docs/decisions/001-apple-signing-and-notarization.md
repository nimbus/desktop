# 001 — Apple signing and notarization

- **Status:** accepted (DS0A)
- **Date:** 2026-05-15
- **Decision owner:** `nimbus/desktop` maintainers
- **Parent plan:** `nimbus/nimbus:docs/plans/desktop-shell-plan.md` → DS0A

## Context

The macOS desktop shell must be Developer-ID-signed and Apple-notarized
before users can launch it without Gatekeeper warnings. Two
authentication paths are supported by Apple's `notarytool` (the modern
replacement for the deprecated `altool`):

1. **App-specific password** — the Apple ID account password plus a
   per-app secondary password. Long-lived; tied to a human Apple ID;
   rotation is manual.
2. **Apple Connect API key (App Store Connect API)** — a per-team API
   key (`.p8`) plus issuer-id + key-id. Scoped, revocable, fits CI
   conventions, supports rotation without touching the human account.

`@electron/notarize` 3.x supports both paths.

## Decision

Use the **Apple Connect API key** path.

`@electron/notarize` configuration shape (CI environment, never written
into source):

```ts
await notarize({
  appPath,
  appleApiKey: process.env.APPLE_API_KEY_PATH,   // path to .p8 file
  appleApiKeyId: process.env.APPLE_API_KEY_ID,   // 10-char key id
  appleApiIssuer: process.env.APPLE_API_ISSUER,  // issuer UUID
});
```

The signing identity itself ("Developer ID Application: …") is procured
via the Apple Developer Program and installed in the CI runner keychain
during the release workflow. The API key only authenticates the
notarization submission; it does not sign.

## Rejected alternatives

- **App-specific password** — rejected. Tied to a human Apple ID; the
  rotation process requires manually regenerating the password through
  appleid.apple.com, which does not fit CI conventions and produces
  no audit trail.

## Secret names (GitHub Actions secrets on `nimbus/desktop`)

| Name | Purpose |
| --- | --- |
| `DESKTOP_APPLE_API_KEY` | Base64-encoded `.p8` private key contents |
| `DESKTOP_APPLE_API_KEY_ID` | 10-character API key id |
| `DESKTOP_APPLE_API_ISSUER` | App Store Connect issuer UUID |
| `DESKTOP_APPLE_TEAM_ID` | Apple Developer Program team id |
| `DESKTOP_APPLE_SIGNING_IDENTITY` | Full identity string (e.g. `Developer ID Application: <Org> (<TeamID>)`) |
| `DESKTOP_APPLE_CERT_P12` | Base64-encoded `.p12` of the Developer ID Application certificate (imported into the runner keychain) |
| `DESKTOP_APPLE_CERT_P12_PASSWORD` | Password for the `.p12` import |

DS0B verifies these names exist via `gh secret list`; values are never
echoed.

## Rotation

- **Rotation cadence:** API keys rotate every 12 months; certificates
  rotate every 12–14 months (the certificate expires from Apple's side
  before the next release window — set a calendar reminder 60 days before
  expiration).
- **Rotation procedure:**
  1. Generate a new App Store Connect API key in
     [App Store Connect → Users and Access → Keys](https://appstoreconnect.apple.com).
  2. Update `DESKTOP_APPLE_API_KEY`, `DESKTOP_APPLE_API_KEY_ID`,
     `DESKTOP_APPLE_API_ISSUER` via `gh secret set`.
  3. Run a dry-run release workflow against a pre-release tag to
     confirm the new key authenticates.
  4. Revoke the old key in App Store Connect.
- **Rotation contact:** the operator who provisioned the original
  Apple Developer Program enrollment. Recorded in the team's internal
  credentials registry (1Password / Bitwarden); not committed here.

## Unresolved manual procurement

- Apple Developer Program enrollment ($99/year, Apple-account-bound,
  requires DUNS or individual verification).
- Apple Developer ID Application certificate generation in
  [developer.apple.com → Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list).
- App Store Connect API key generation and base64 encoding of the
  resulting `.p8` for upload to GitHub Actions secrets.
- Notarization profile entitlements (`entitlements.mac.plist`) — landed
  in DS3.

These items must be completed by a human operator before DS0B can pass.
