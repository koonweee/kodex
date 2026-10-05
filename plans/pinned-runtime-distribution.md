# Pinned upstream runtime distribution

## Status

Complete — deployed 2026-10-05.

## Scope

Replace desktop-app extraction with the complete official Codex release package matching the checked-in app-server schema version and host architecture. Verify artifact integrity and required executable/helper behavior before switching the live service. Remove desktop source configuration and packaging branches. Keep dedicated CODEX_HOME, staged release switching and self-contained rollback releases.

The prior pending desktop-package-copy patch is superseded, not deployed. Service-controller changes must apply on the first update by invoking the checkout updater, not the previous installed controller.

Audit adjacent runtime, deployment and client integration for similarly brittle shortcuts. Record concrete findings separately from necessary native bridges; do not broaden implementation into unrelated subsystem changes.

## Validation

Service unit tests, verified official archive layout and executable/helper smoke checks, independent review, and installed service update with live health checks. Prefer a disposable real-native Code Mode execution proof where practical. Preserve existing account, project and chat storage.

Focused audit findings are recorded in [runtime integration shortcuts](../docs/audits/2026-10-05-runtime-integration-shortcuts.md). Follow-ups remain separate from this runtime acquisition change.

The verified `0.160.0` official package includes both executable and Code Mode host. Service tests cover archive integrity/layout, missing helpers, failed helper startup, unknown pins and preserving the live release on staging failure. Runtime metadata records the official URL/asset/SHA256. Old private `codex_binary` fields remain ignored so older rollback controllers can still read their configuration.

## Completion evidence

- 24 service tests passed; backend trim, formatting and independent review passed.
- All 25 real-native integration cases passed against the official package (24 in the suite, then the corrected project fixture passed separately). The fixture now follows sole-project-root execution rather than the removed per-chat cwd override.
- Official experimental schema output matched all 440 checked-in JSON schemas.
- Deployed with the checkout controller to release `20261005-154135-7fec2d98`; manifest records the official asset URL and verified digest.
- Installed runtime symlink passed the disposable real-native Code Mode execution test. Readiness, signed-in account presence, sidebar read and private HTTPS returned successfully. Existing account and chat storage were retained.
- Audit follow-ups remain documented separately and are not part of this completed implementation.
