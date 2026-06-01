# Native Thread Settings Plan

## Status

Complete.

Implemented in the native thread settings review loop. Gateway and web selected-thread setting changes now use `thread/settings/update`, native notifications refresh gateway-owned thread metadata, generated OpenAPI clients were regenerated, and the iOS client can update selected-thread settings through the same gateway route.

Surviving gateway `thread_composer_settings` storage is intentionally fallback-scoped for draft thread creation, queued/automation submission data, and legacy fill-only overlays when app-server summaries omit structured settings.

## Context

Codex app-server 0.133+ added `thread/settings/update` and emits `thread/settings/updated` for effective next-turn settings. Kodex currently preserves similar behavior with gateway-owned `thread_composer_settings`, create/turn option overlays, and frontend heuristics. After the [Codex 0.135 app-server bump plan](codex-0-135-app-server-bump.md), this plan moves existing-thread next-turn setting ownership back to app-server and removes the gateway replay/overlay code that duplicates it.

Contract sources are the checked-in generated schema under `apps/gateway/app-server-schema/<version>/json` after the bump and the upstream app-server README. Do not infer request shapes from the current Kodex wrappers.

## Starting State

- `apps/gateway/src/schema.rs` pins `APP_SERVER_SCHEMA_VERSION` to `0.130.0`, so the native method is not in the local generated schema yet.
- `apps/gateway/src/routes/threads.rs` manually saves and overlays thread composer settings through `save_thread_creation_options`, `save_thread_turn_options`, and `overlay_stored_thread_composer_settings`.
- `apps/gateway/src/app_server_api.rs` sends model, effort, service tier, approval, reviewer, and sandbox fields in `turn/start` options.
- `apps/web/src/composer/settings.ts` derives thread settings from a mix of structured fields and raw app-server payloads.
- `plans/app-server-resume-fork-settings-simplification.md` is still Proposed and overlaps with the cleanup portion, but it predates native `thread/settings/update`.

## Goals

- Use app-server `thread/settings/update` for loaded-thread next-turn settings changes that do not start a turn.
- Treat `thread/settings/updated` as the canonical convergence signal for loaded thread settings.
- Remove or sharply narrow gateway-owned per-thread composer setting persistence where app-server now owns the same state.
- Keep automation submission semantics explicit instead of accidentally inheriting interactive composer settings.

## Non-Goals

- Do not redesign the composer UI.
- Do not introduce browser-local durable setting caches.
- Do not change approval response handling.
- Do not use raw app-server events directly in React as durable state.

## Milestones

### 1. Contract and Schema Audit

- Verify the post-bump request and notification shapes for `thread/settings/update`, `thread/settings/updated`, `turn/start` setting persistence, `permissions`, `sandboxPolicy`, and `activePermissionProfile`.
- Decide whether Kodex can hard-require the new method or needs a temporary diagnostic failure path for mismatched binaries.
- Record any API DTO changes needed for gateway OpenAPI and frontend generated types.

### 2. Gateway Native Settings Adapter

- Add typed app-server wrappers for `thread/settings/update` and `thread/settings/updated`.
- Add or update a gateway route for selected-thread setting changes, likely `PATCH /v1/threads/{threadId}/settings`, using gateway DTOs that mirror the generated app-server contract.
- Normalize native setting notifications into gateway-owned events and selected-thread `thread_view.patch` or metadata updates where appropriate.
- Add backend contract tests for accepted partial updates, explicit null clearing, and sandbox/profile conflict rejection.

### 3. Remove Duplicate Gateway Persistence

- Replace existing-thread setting writes in `save_thread_turn_options` and `overlay_stored_thread_composer_settings` with native app-server settings.
- Keep only the local persistence still needed for draft-thread creation, automation-specific submitted options, or older data migration.
- Rename any surviving storage so it no longer reads as canonical thread settings.
- Add regression tests showing a refetched or second client sees app-server-owned next-turn settings without relying on React memory.

### 4. Frontend Convergence

- Route composer setting changes through the gateway native settings route.
- Derive selected-thread settings from gateway snapshots and native setting events, not raw payload fallback heuristics where structured fields exist.
- Keep optimistic UI short-lived and reconcile from the next gateway event or refetch.
- Update focused composer settings tests and include a same-user two-tab test shape for stale tab convergence.

## Verification

- `cargo fmt`
- `cargo test`
- Regenerate gateway OpenAPI and frontend schema types if DTOs change.
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Use `$agent-browser` for a desktop plus narrow viewport smoke where changing settings in one tab converges in another.

## Risks And Open Questions

- Existing automations may intentionally need frozen submission options; do not remove that behavior without a separate product decision.
- Native settings require loaded threads, so stored but not loaded thread behavior must be verified before removing all local fallback paths.
- Permission profiles and sandbox policies are changing at the same boundary; implementation should sequence after or together with the native permission profile plan.
