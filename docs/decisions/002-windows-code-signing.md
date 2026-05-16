# 002 — Windows code signing

- **Status:** accepted (DS0A); **activation deferred** — see below
- **Date:** 2026-05-15
- **Decision owner:** `nimbus/desktop` maintainers
- **Parent plan:** `nimbus/nimbus:docs/plans/desktop-shell-plan.md` → DS0A

## Deferral status

**First release ships macOS + Linux only. Windows is intentionally
deferred to a follow-up release.**

Rationale: Azure Trusted Signing onboarding requires organization legal
verification with Microsoft (1–3 week lead time) before any artifact
can be signed. Decoupling it from the first release keeps the critical
path on Apple Developer Program enrollment + Developer ID Application
certificate, both of which are operator-driven on a much shorter
horizon. The decision below stays the chosen path; only its activation
is staged.

While deferred:

- The decision and secret-name registry below remain authoritative —
  flipping Windows from deferred to active is a one-line move in
  `scripts/verify-secrets.sh` (relocate `DEFERRED_WINDOWS_SECRETS`
  into `REQUIRED_SECRETS`) once Trusted Signing is provisioned.
- `scripts/verify-secrets.sh` reports the Windows secret names but
  does **not** fail DS0B on their absence.
- DS6 packaging may produce an unsigned Windows artifact for internal
  smoke testing, but no signed Windows binary leaves the build.
- DS8 (code signing) and DS9 (release CI) bring up macOS first; their
  Windows lanes activate when this decision flips to "accepted —
  active".

This deferral block is the only authoritative statement that Windows
ships late; the rest of the document remains correct as written and
will not need a rewrite when activation lands.

## Context

The Windows NSIS installer must be signed to avoid Microsoft Defender
SmartScreen warnings and to be acceptable for enterprise deployment. As
of 2026 there are two production-grade paths:

1. **Azure Trusted Signing (formerly Azure Code Signing)** — a managed
   signing service. Microsoft holds the key in their HSM; CI authenticates
   via an Azure service principal and submits binaries for signing. No
   hardware token ships to the build host. EV-equivalent trust level for
   SmartScreen reputation. Released to GA in 2024.
2. **EV (Extended Validation) certificate on a physical HSM token** —
   the historical path. Requires shipping a USB HSM token (YubiKey FIPS,
   SafeNet, etc.) to a dedicated signing host, manual PIN entry per sign,
   and yearly identity revalidation. Establishes SmartScreen reputation
   immediately on first signed release.

`electron-builder` 26.x supports both via the `win.signtoolOptions` and
`@vercel/azurewriter`-compatible signing hooks.

## Decision

Use **Azure Trusted Signing** as the primary path.

`electron-builder.yml` configuration shape (values from CI env, never in
the repo):

```yaml
win:
  signtoolOptions:
    sign: scripts/sign-windows.cjs   # invokes Azure Trusted Signing client
  publisherName: "Nimbus, Inc."
  rfc3161TimeStampServer: "http://timestamp.acs.microsoft.com"
```

The `sign-windows.cjs` hook (landed in DS8) authenticates the Azure
service principal using `AZURE_CLIENT_ID` / `AZURE_TENANT_ID` /
`AZURE_CLIENT_SECRET` from CI env, then submits each artifact to the
Trusted Signing endpoint identified by `DESKTOP_WINDOWS_TS_ENDPOINT` and
`DESKTOP_WINDOWS_TS_CERT_PROFILE`.

## Fallback

**EV HSM physical token** is the contingency path if Azure Trusted
Signing access is blocked for the organization (account onboarding,
geographic restriction, or budget). The fallback requires:

- A dedicated, network-isolated Windows signing host.
- A FIPS-validated HSM token (YubiKey 5 FIPS or SafeNet eToken 5110+).
- A manual signing step gated outside CI (the token PIN must be
  entered by a human; automated signing of an EV cert is a violation of
  the cert terms).

This fallback is documented but not implemented in `sign-windows.cjs` —
landing the EV path requires re-running DS8 with the alternative
toolchain.

## Rejected alternatives

- **Standard (non-EV) OV code signing certificate** — rejected.
  SmartScreen reputation accumulates only after several thousand
  installs; users see "unrecognized publisher" warnings until the
  reputation builds. Unacceptable for an enterprise console.
- **Self-signed** — rejected. Defender blocks installation.

## Secret names (GitHub Actions secrets on `nimbus/desktop`)

| Name | Purpose |
| --- | --- |
| `DESKTOP_WINDOWS_TS_TENANT_ID` | Azure AD tenant id |
| `DESKTOP_WINDOWS_TS_CLIENT_ID` | Azure service principal app id |
| `DESKTOP_WINDOWS_TS_CLIENT_SECRET` | Service principal client secret |
| `DESKTOP_WINDOWS_TS_ENDPOINT` | Azure Trusted Signing endpoint URL |
| `DESKTOP_WINDOWS_TS_ACCOUNT_NAME` | Trusted Signing account name |
| `DESKTOP_WINDOWS_TS_CERT_PROFILE` | Certificate profile name |

DS0B verifies these names exist via `gh secret list`; values are never
echoed.

## Rotation

- **Rotation cadence:** Azure service principal secrets rotate every
  6 months (Azure default policy). Certificate profiles themselves are
  managed inside Trusted Signing and renew automatically.
- **Rotation procedure:**
  1. Generate a new client secret on the service principal in
     [Azure Portal → App registrations → certificates & secrets](https://portal.azure.com).
  2. Update `DESKTOP_WINDOWS_TS_CLIENT_SECRET` via `gh secret set`.
  3. Run a dry-run release workflow on a pre-release tag.
  4. Remove the old client secret from the app registration.
- **Rotation contact:** the operator who owns the Azure subscription
  for Trusted Signing. Recorded in the team's internal credentials
  registry; not committed here.

## Unresolved manual procurement

- Azure subscription with Trusted Signing onboarded (requires
  organization legal verification per Microsoft's identity proofing
  process; lead time 1–3 weeks).
- Azure service principal creation with the
  `Microsoft.CodeSigning/codeSignAccounts/certificateProfiles/sign`
  permission on the certificate profile resource.
- Optional contingency: procurement of an EV HSM physical token and
  designated signing host if Trusted Signing onboarding is blocked.

These items must be completed by a human operator before DS0B can pass.
