#!/usr/bin/env bash
# verify-secrets.sh — DS0B gate for nimbus/desktop
#
# Confirms that the GitHub Actions secret NAMES listed in
# docs/decisions/00{1,2,3}-*.md exist on the nimbus/desktop repo. This
# script intentionally checks names only — `gh secret list` does not
# return values, and this script never attempts to read them.
#
# Authored in DS0A; run by an operator (or CI) after the manual
# procurement items in the decision docs have been completed.
#
# Two tiers:
#   - REQUIRED:  gates DS0B for the first release (macOS + Linux).
#                Apple signing/notarization + GitHub Releases token.
#   - DEFERRED:  Windows code signing via Azure Trusted Signing. The
#                first release ships macOS + Linux; Windows lands in a
#                later release once Trusted Signing is provisioned.
#                Reported here so the scaffolding stays in place and
#                flipping these to required is a one-line change.
#
# Usage:
#   ./scripts/verify-secrets.sh
#
# Exit codes:
#   0   all REQUIRED secret names present (DEFERRED status is informational)
#   1   one or more REQUIRED secret names missing
#   2   prerequisites missing (gh CLI not installed, not authenticated,
#       or repo not accessible)

set -euo pipefail

REPO="${NIMBUS_DESKTOP_REPO:-nimbus/desktop}"

# 001 — Apple signing and notarization (REQUIRED)
APPLE_SECRETS=(
  "DESKTOP_APPLE_API_KEY"
  "DESKTOP_APPLE_API_KEY_ID"
  "DESKTOP_APPLE_API_ISSUER"
  "DESKTOP_APPLE_TEAM_ID"
  "DESKTOP_APPLE_SIGNING_IDENTITY"
  "DESKTOP_APPLE_CERT_P12"
  "DESKTOP_APPLE_CERT_P12_PASSWORD"
)

# 003 — Auto-update channel via GitHub Releases (REQUIRED, optional)
#
# The default release workflow uses the auto-provisioned `GITHUB_TOKEN`
# with `contents: write` permission, which requires no operator action.
# Setting `DESKTOP_GH_RELEASE_TOKEN` is only needed if audit policy
# requires a dedicated fine-grained PAT. Treated as REQUIRED-OPTIONAL
# here: presence is preferred but absence does not fail DS0B.
UPDATE_SECRETS_OPTIONAL=(
  "DESKTOP_GH_RELEASE_TOKEN"
)

# 002 — Windows code signing via Azure Trusted Signing (DEFERRED)
#
# Reported but does not gate DS0B. When Trusted Signing onboarding
# completes and Windows release work begins, move this array up into
# REQUIRED_SECRETS so the gate enforces presence.
DEFERRED_WINDOWS_SECRETS=(
  "DESKTOP_WINDOWS_TS_TENANT_ID"
  "DESKTOP_WINDOWS_TS_CLIENT_ID"
  "DESKTOP_WINDOWS_TS_CLIENT_SECRET"
  "DESKTOP_WINDOWS_TS_ENDPOINT"
  "DESKTOP_WINDOWS_TS_ACCOUNT_NAME"
  "DESKTOP_WINDOWS_TS_CERT_PROFILE"
)

REQUIRED_SECRETS=(
  "${APPLE_SECRETS[@]}"
)

log() { printf '%s\n' "$*" >&2; }

if ! command -v gh >/dev/null 2>&1; then
  log "error: gh CLI not installed"
  log "  install: https://cli.github.com/"
  exit 2
fi

if ! gh auth status >/dev/null 2>&1; then
  log "error: gh CLI not authenticated"
  log "  run: gh auth login"
  exit 2
fi

if ! gh repo view "$REPO" >/dev/null 2>&1; then
  log "error: cannot access repo $REPO"
  log "  (check gh auth scopes and repo visibility)"
  exit 2
fi

log "DS0B: verifying secret names on $REPO"
log "      (names only — values are never read or printed)"
log ""

# `gh secret list --json name` returns one JSON entry per secret; jq
# extracts just the name field.
EXISTING_NAMES="$(gh secret list --repo "$REPO" --json name --jq '.[].name' 2>/dev/null || true)"

if [ -z "$EXISTING_NAMES" ]; then
  log "warning: gh secret list returned no entries"
  log "         (the repo may have no secrets configured yet)"
fi

group_present=0
group_missing=0
check_group() {
  local group_label="$1"
  shift
  group_present=0
  group_missing=0
  log "[$group_label]"
  for name in "$@"; do
    if printf '%s\n' "$EXISTING_NAMES" | grep -Fxq "$name"; then
      log "  ok        $name"
      group_present=$((group_present + 1))
    else
      log "  missing   $name"
      group_missing=$((group_missing + 1))
    fi
  done
  log "  ($group_present present, $group_missing missing)"
  log ""
}

check_group "required (DS0B gate)" "${REQUIRED_SECRETS[@]}"
required_present=$group_present
required_missing=$group_missing

check_group "required-optional (uses GITHUB_TOKEN by default)" "${UPDATE_SECRETS_OPTIONAL[@]}"
optional_present=$group_present
optional_missing=$group_missing

check_group "deferred — Windows (Trusted Signing; not yet a DS0B gate)" "${DEFERRED_WINDOWS_SECRETS[@]}"
deferred_present=$group_present
deferred_missing=$group_missing

log "summary:"
log "  required:           $required_present present / $required_missing missing"
log "  required-optional:  $optional_present present / $optional_missing missing"
log "  deferred (Windows): $deferred_present present / $deferred_missing missing"
log ""

if [ "$required_missing" -gt 0 ]; then
  log "DS0B is not yet satisfied. Procure the missing REQUIRED credentials"
  log "per docs/decisions/001-apple-signing-and-notarization.md and upload"
  log "them via:"
  log "  gh secret set <NAME> --repo $REPO"
  log ""
  log "Windows secrets in the 'deferred' group are intentionally not"
  log "required for the first release. They become required when Azure"
  log "Trusted Signing is provisioned and Windows release work begins."
  exit 1
fi

log "DS0B satisfied: all REQUIRED secret names present on $REPO."
if [ "$deferred_missing" -gt 0 ]; then
  log ""
  log "Note: $deferred_missing Windows (deferred) secret name(s) not yet"
  log "present. This is expected for the first release. See"
  log "docs/decisions/002-windows-code-signing.md for activation steps."
fi
exit 0
