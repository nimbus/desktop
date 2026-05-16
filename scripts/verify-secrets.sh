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
# Usage:
#   ./scripts/verify-secrets.sh
#
# Exit codes:
#   0   all required secret names present
#   1   one or more required secret names missing
#   2   prerequisites missing (gh CLI not installed, not authenticated,
#       or repo not accessible)

set -euo pipefail

REPO="${NIMBUS_DESKTOP_REPO:-nimbus/desktop}"

# Required secret names, sourced from the decision documents.
# 001 — Apple signing and notarization
APPLE_SECRETS=(
  "DESKTOP_APPLE_API_KEY"
  "DESKTOP_APPLE_API_KEY_ID"
  "DESKTOP_APPLE_API_ISSUER"
  "DESKTOP_APPLE_TEAM_ID"
  "DESKTOP_APPLE_SIGNING_IDENTITY"
  "DESKTOP_APPLE_CERT_P12"
  "DESKTOP_APPLE_CERT_P12_PASSWORD"
)

# 002 — Windows code signing (Azure Trusted Signing primary path)
WINDOWS_SECRETS=(
  "DESKTOP_WINDOWS_TS_TENANT_ID"
  "DESKTOP_WINDOWS_TS_CLIENT_ID"
  "DESKTOP_WINDOWS_TS_CLIENT_SECRET"
  "DESKTOP_WINDOWS_TS_ENDPOINT"
  "DESKTOP_WINDOWS_TS_ACCOUNT_NAME"
  "DESKTOP_WINDOWS_TS_CERT_PROFILE"
)

# 003 — Auto-update channel (GitHub Releases primary path)
UPDATE_SECRETS=(
  "DESKTOP_GH_RELEASE_TOKEN"
)

REQUIRED_SECRETS=(
  "${APPLE_SECRETS[@]}"
  "${WINDOWS_SECRETS[@]}"
  "${UPDATE_SECRETS[@]}"
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

# `gh secret list` prints one secret name per line in the first column.
# We strip everything after the first whitespace to get just the name.
EXISTING_NAMES="$(gh secret list --repo "$REPO" --json name --jq '.[].name' 2>/dev/null || true)"

if [ -z "$EXISTING_NAMES" ]; then
  log "warning: gh secret list returned no entries"
  log "         (the repo may have no secrets configured yet)"
fi

missing=0
present=0
for name in "${REQUIRED_SECRETS[@]}"; do
  if printf '%s\n' "$EXISTING_NAMES" | grep -Fxq "$name"; then
    log "  ok       $name"
    present=$((present + 1))
  else
    log "  MISSING  $name"
    missing=$((missing + 1))
  fi
done

log ""
log "summary: $present present, $missing missing"

if [ "$missing" -gt 0 ]; then
  log ""
  log "DS0B is not yet satisfied. Procure the missing credentials per"
  log "docs/decisions/00{1,2,3}-*.md and upload them via:"
  log "  gh secret set <NAME> --repo $REPO"
  exit 1
fi

log "DS0B satisfied: all required secret names present on $REPO"
exit 0
