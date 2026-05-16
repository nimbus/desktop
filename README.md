# nimbus/desktop

Native desktop shell for the Nimbus operator console — Phase 2 of the
desktop UI initiative.

This repo wraps the embedded `nimbus-ui` SPA in a signed, notarized,
auto-updating Electron application. It is **separate from `nimbus/nimbus`**
on purpose so the desktop release cadence, packaging matrix, and signing
credentials stay isolated from the core server.

## Status

`pending` — scaffold and decisions only. The hello-electron loop lands in
DS1 of `docs/plans/desktop-shell-plan.md` in the parent repo. See the
parent plan for the canonical roadmap; this README is intentionally thin.

## Platform rollout

**Phase 2 first release: macOS + Linux. Windows is deferred to a
follow-up release.**

Azure Trusted Signing onboarding requires organization legal
verification with Microsoft (1–3 week lead time) and is decoupled from
the first release so the critical path stays on Apple Developer Program
enrollment + Developer ID Application certificate. The Windows code
signing decision is captured in
[`docs/decisions/002-windows-code-signing.md`](./docs/decisions/002-windows-code-signing.md)
and its scaffolding (secret-name registry, decision document) stays in
place during the deferral. Flipping Windows from deferred to active is
a one-line move in `scripts/verify-secrets.sh` once Trusted Signing is
provisioned.

| Platform | First release? | Signing | Notes |
| --- | --- | --- | --- |
| macOS  | yes | Developer ID + notarization | gated on Apple enrollment + cert (DS0B-required) |
| Linux  | yes | unsigned (community standard) | AppImage / deb / rpm |
| Windows | **deferred** | Azure Trusted Signing | scaffolded; activation gated on TS onboarding |

## Stack

- Electron 42.x (Chromium-bundled renderer)
- electron-builder 26.8.x (canonical packaging)
- electron-updater 6.8.x (auto-update channel)
- `@electron/notarize` 3.x (macOS notarization)
- TypeScript 6, strict mode, ESM only
- Biome 2.4.x (mirrors `nimbus-ui` lint/format)
- Vitest (unit) + Playwright (E2E against the packaged shell)

## Decisions

External decisions for signing, notarization, and update hosting live in
[`docs/decisions/`](./docs/decisions/). DS0A captures the chosen paths and
the unresolved manual procurement items. Secret values never enter this
repo.

## Verifying secret presence

`scripts/verify-secrets.sh` (DS0B) checks that the required
`gh secret list` names exist on this repo — it confirms presence only and
never prints values. Run it after the operator has provisioned the Apple,
Windows, and update-channel credentials documented in the decision docs:

```sh
npm run verify:secrets
```

## Parent plan

See `docs/plans/desktop-shell-plan.md` and `docs/plans/desktop-ui-plan.md`
in `nimbus/nimbus` for the full DS0–DS10 roadmap.
