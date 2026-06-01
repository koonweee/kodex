# Codex 0.135 App-Server Bump Plan

## Status

Complete.

## Completion Notes

- Generated `apps/gateway/app-server-schema/0.135.0/json` from `codex-cli 0.135.0`.
- Updated gateway schema validation to use `APP_SERVER_SCHEMA_VERSION` `0.135.0`.
- Added capabilities diagnostics for checked-in schema version, detected Codex CLI version, and version/schema match status.
- Confirmed the 0.135 schema includes the expected follow-up APIs: `thread/settings/update`, `thread/settings/updated`, `thread/status/changed`, `permissionProfile/list`, `activePermissionProfile`, and hook lifecycle events including `subagentStart`/`subagentStop`.
- Regenerated frontend OpenAPI types for the public capabilities DTO change.

## Context

Kodex is currently pinned to the generated Codex app-server `0.130.0` schema. The native adoption plans for thread settings, permission profiles, thread sync events, and subagent discovery all depend on app-server APIs documented after that version. This precursor plan owns the stable app-server bump and schema regeneration boundary so feature adoption can happen in smaller follow-up plans.

Contract sources are the upstream app-server README and the generated schema produced by the configured `codex` binary. The checked-in generated schema remains the local source of truth after this plan completes.

## Current State

- `apps/gateway/src/schema.rs` declares `APP_SERVER_SCHEMA_VERSION` as `0.130.0`.
- Checked-in schemas live under `apps/gateway/app-server-schema/0.130.0/json`.
- Gateway wrappers and tests were built against the 0.130 contract.
- Follow-up plans need native `thread/settings/update`, `thread/settings/updated`, `thread/status/changed`, `permissionProfile/list`, `permissions`, and `activePermissionProfile` shapes.

## Goals

- Bump Kodex's checked-in app-server schema target from `0.130.0` to stable `0.135.0`.
- Regenerate the app-server JSON schemas with experimental API output enabled.
- Keep current Kodex behavior working without adopting new native app-server features in this plan.
- Surface version or capability diagnostics if they are needed to make schema/binary mismatches obvious.
- Produce a clean baseline for the four native-adoption plans.

## Non-Goals

- Do not replace gateway-owned thread setting overlays in this plan.
- Do not migrate permission UI to app-server profiles in this plan.
- Do not remove polling or subagent scan paths in this plan.
- Do not redesign app-server process supervision or transport.

## Milestones

### 1. Version and Schema Regeneration

- Update the configured Codex binary/version references used by Kodex development and tests.
- Run `apps/gateway/scripts/generate-app-server-schema.sh` with the target `codex` binary.
- Commit the generated `apps/gateway/app-server-schema/0.135.0/json` output.
- Update `APP_SERVER_SCHEMA_VERSION` and any schema path references from `0.130.0` to `0.135.0`.

### 2. Compatibility Compile Pass

- Fix Rust schema validation, request wrapper, and DTO compile failures caused by changed app-server shapes.
- Preserve existing public gateway routes and frontend generated types unless a compatibility fix requires a DTO change.
- Add narrowly scoped compatibility tests for changed required/optional fields.
- Avoid using new methods beyond startup/version checks.

### 3. Runtime Startup and Diagnostics

- Verify app-server initialize still sends the required `clientInfo` and `experimentalApi` capability.
- Check whether the app-server version diagnostic added upstream can be read cheaply from the configured binary or process.
- If practical, expose a gateway diagnostic that reports configured schema version versus detected app-server version.
- Make mismatched binary/schema failures actionable in logs or `/v1/capabilities`.

### 4. Baseline Verification and Handoff

- Run backend formatting and tests.
- Regenerate gateway OpenAPI and frontend generated types only if the public gateway contract changed.
- Run focused frontend tests only if generated frontend API types or compatibility-facing DTOs change.
- Update the four native-adoption plans if the actual generated schema changes their implementation assumptions.

## Verification

- `cargo fmt`
- `cargo test`
- `apps/gateway/scripts/generate-app-server-schema.sh`
- Inspect `apps/gateway/app-server-schema/0.135.0/VERSION` and representative JSON schemas for the expected native APIs.
- Regenerate and verify OpenAPI/frontend types if gateway public DTOs change.

## Follow-Up Plans

- [Native thread settings plan](native-thread-settings.md)
- [Native permission profiles plan](native-permission-profiles.md)
- [Native thread sync events plan](native-thread-sync-events.md)
- [Native subagent discovery plan](native-subagent-discovery.md)

## Risks And Open Questions

- The local `codex` binary must match the target stable release before schema generation.
- Schema changes may force compatibility edits outside the app-server wrapper layer.
- If app-server 0.135 contains breaking behavior changes unrelated to the desired native APIs, this plan should stop at compatibility fixes and document any follow-up work instead of mixing feature adoption into the bump.
