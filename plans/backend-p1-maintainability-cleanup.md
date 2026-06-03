# Backend P1 Maintainability Cleanup Plan

## Context

- `audit-backend.md` identifies the highest-priority backend cleanup pressure in four areas: the app-server adapter, SQLite store ownership, thread settings permission-profile overlays, and gateway runtime status strings.
- The cleanup is behavior-preserving. HTTP routes, SSE event names, generated OpenAPI DTOs, app-server JSON-RPC request/response shapes, SQLite table names, and local/VPN-only deployment assumptions should stay unchanged.
- The work must preserve the repo's backend ownership rules: generated app-server schemas under `apps/gateway/app-server-schema/<version>/json` remain the wire-contract source of truth, gateway-owned shared lifecycle state stays in the gateway, and browser-visible timeline history continues to come from canonical thread view snapshots, patches, and item deltas.

## Current State

- `apps/gateway/src/app_server_api.rs` is about 5,400 lines and mixes `CodexClient` RPC methods, app-server request DTOs, app-server response DTOs, JSON payload parsing, compact timeline payload shaping, canonical timeline row construction, permission-profile parsing, and adapter tests.
- `apps/gateway/src/store.rs` is about 5,400 lines and owns SQLite schema setup, migrations, event persistence, project/previews, approvals, notifications, read state, pins, queued inputs, automations, runtime state, row mappers, and storage tests.
- `apps/gateway/src/routes/threads.rs` and `apps/gateway/src/events.rs` both contain thread settings permission overlay helpers. Route-driven `PATCH /v1/threads/{threadId}/settings` uses `save_thread_settings_permissions_patch` and `apply_thread_settings_permissions_patch`; app-server `thread/settings/updated` ingestion uses a separate `ActivePermissionProfilePatch`, `active_permission_profile_patch_from_settings`, `save_thread_settings_permissions_patch`, and `apply_active_permission_profile_patch`.
- Runtime state is represented by `ThreadRuntimeState { status: String, ... }` in `apps/gateway/src/store.rs`. String literals such as `starting`, `draining`, `syncing`, `active`, `streaming`, `idle`, and `unknown` are matched or written in `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/queue.rs`, `apps/gateway/src/events.rs`, and store SQL. By contrast, nearby queue and automation state already use typed enums such as `QueuedInputStatus`, `QueuedInputPriority`, and `AutomationStatus`.
- Existing backend guardrails include inline module tests in `app_server_api.rs` and `store.rs`, focused event tests in `apps/gateway/src/events/tests.rs`, route tests in `apps/gateway/src/routes/mod.rs`, and full backend verification through `cargo fmt` and `cargo test`.

## Milestones

### 1. Split App-Server Adapter Responsibilities

- Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/lib.rs`, and extracted adapter modules under a stable public `app_server_api` module path.
- Work:
  - Convert the current single-file adapter into a module directory, keeping existing public imports such as `crate::app_server_api::client`, `CodexClient`, `ThreadSummary`, `ThreadDetailResponse`, `ThreadTimelineRow`, `TurnStartOptions`, and `UserInput` available through `app_server_api`.
  - Extract pure timeline projection and compact display helpers near the existing `thread_view` ownership boundary, including `thread_timeline_rows_from_items`, `ThreadTimelineSnapshotItem::from_turn_item`, `compact_timeline_item_payload`, and related row-building tests.
  - Extract app-server RPC client methods and transport-facing request helpers from `CodexClient` into a client submodule while preserving request validation through `schema::validate_client_request_params`.
  - Keep app-server response DTO parsing and schema-shaped request DTOs in adapter-owned modules; do not hand-write new public contract docs or infer app-server behavior outside the checked-in schema files.
  - Move existing adapter tests with the code they cover before changing behavior. Use this milestone for mechanical ownership splits first; defer parser or row-shaping behavior changes unless a test exposes a real bug.
- Exit criteria:
  - `cargo fmt` passes after the module split.
  - Focused adapter tests covering thread list/read parsing, timeline row construction, compact payload shaping, settings update request payloads, and permission profile parsing still pass.
  - `cargo test -p kodex-gateway app_server_api` or the closest available focused cargo test filter passes, followed by `cargo test -p kodex-gateway` before milestone completion.
  - Public gateway routes continue compiling without broad import churn outside adapter consumers.

### 2. Split Store Into Migration And Domain Modules

- Scope: `apps/gateway/src/store.rs`, extracted store modules, and storage tests currently under `#[cfg(test)] mod tests`.
- Work:
  - Keep the `Store` type, public method names, table names, and SQL behavior stable while moving storage responsibilities into sibling modules such as migrations, events, projects/previews, approvals, notifications, reads/pins, queue, automations, runtime state, skill mentions, and row mapping.
  - Move `Store::migrate`, `Store::assert_wal`, legacy schema repair, and migration tests into a migrations-focused module first.
  - Move queued-input, automation, notification, and runtime-state methods with their existing row mappers and tests in separate reviewable chunks.
  - Preserve the current SQLite text columns and enum parsing behavior during the split; semantic changes such as runtime status typing belong in milestone 4.
  - Keep domain tests close to the moved modules, and leave only shared store test helpers in a common test-support module if duplication appears.
- Exit criteria:
  - Migration tests still prove table creation, WAL behavior, legacy overlay repair, and restart recovery behavior.
  - Queue, automation, notification, approval, read/pin, project/preview, and skill mention storage tests still pass after their modules move.
  - `cargo fmt` and `cargo test -p kodex-gateway store` or the closest available focused cargo test filter pass after each store split chunk.
  - `Store` consumers in routes, events, queue, notifications, automations, previews, and self-control compile without behavior-facing API changes.

### 3. Deduplicate Thread Settings Permission Overlay Projection

- Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/store.rs`, and a shared helper module such as `apps/gateway/src/thread_settings_projection.rs` or an ownership-equivalent backend module.
- Work:
  - Extract a shared `ActivePermissionProfilePatch` contract that represents `Missing`, `Clear`, and `Set(ActivePermissionProfile)` for both route request patches and app-server `thread/settings/updated` payloads.
  - Extract shared persistence logic for saving only the local permissions overlay in `thread_local_settings_overlays` while clearing approval policy, approvals reviewer, and sandbox fields.
  - Extract shared projection logic that updates both `ThreadSummary.active_permission_profile` and `ThreadSummary.raw_payload["activePermissionProfile"]` consistently.
  - Update `update_thread_settings` in `routes/threads.rs` and `normalized_thread_settings_event` in `events.rs` to use the same parse, save, apply, and broadcast-ready projection helpers.
  - Add focused unit tests for `Missing`, `Clear`, and `Set` patches against typed summary fields, raw payload mutation, and local overlay persistence. Keep existing route/event tests as integration coverage.
- Exit criteria:
  - Focused tests prove route-driven settings updates and app-server settings events produce equivalent thread summary and raw payload projections for permission profile set and clear cases.
  - Existing settings-related route and event tests still pass, including tests that cover `thread/settings/updated` metadata broadcasts and thread-local settings overlays.
  - No new browser-owned settings cache or stale-tab merge behavior is introduced; gateway/app-server remain authoritative for shared thread settings.
  - `cargo fmt` and focused backend tests for `routes::threads` and `events` settings behavior pass.

### 4. Type Gateway Thread Runtime Status

- Scope: `apps/gateway/src/store.rs` or the extracted runtime store module, `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/queue.rs`, `apps/gateway/src/events.rs`, and focused runtime/queue tests.
- Work:
  - Introduce a `ThreadRuntimeStatus` enum for the gateway-owned runtime vocabulary: `Starting`, `Draining`, `Syncing`, `Active`, `Streaming`, `Idle`, and `Unknown`.
  - Give the enum an `as_str` method for SQLite persistence and a parser that maps recognized persisted text to enum values. Preserve readability of older or unexpected rows by mapping unknown persisted values to `ThreadRuntimeStatus::Unknown` instead of failing normal startup or queue recovery.
  - Change `ThreadRuntimeState.status` from `String` to `ThreadRuntimeStatus`, updating writes in `turn_lifecycle`, `queue`, and `events` to construct enum values instead of string literals.
  - Replace direct `runtime.status.as_str()` string matches in `route_for_thread_input`, `routed_active_turn_id`, and `thread_is_idle_for_queue` with enum matches.
  - Keep SQLite storage as text and keep SQL predicates readable by binding `ThreadRuntimeStatus::as_str()` values or using constants; do not introduce a schema migration solely for this typing cleanup.
  - Add parser tests for every known status plus an unexpected persisted value, and update queue recovery/runtime tests to assert enum values rather than strings.
- Exit criteria:
  - Runtime routing tests cover gateway-pending work, syncing without active turn, syncing with active turn, active/streaming with active turn, idle refresh, draining queue exclusion, and unknown persisted status fallback.
  - Queue drain claim and restart recovery tests continue to prove `draining` claims are preserved, pending queue rows recover to failed, and runtime rows reset to `unknown`.
  - `rg -n '"starting"|"draining"|"syncing"|"streaming"|"unknown"' apps/gateway/src` shows remaining literals only in enum definitions, SQL predicates/tests where intentional, app-server payload parsing, or unrelated status domains.
  - `cargo fmt` and `cargo test -p kodex-gateway` pass.

## Verification

- Run focused tests as each milestone lands, using the closest stable filters for the moved modules:
  - `cargo test -p kodex-gateway app_server_api`
  - `cargo test -p kodex-gateway store`
  - `cargo test -p kodex-gateway thread_settings`
  - `cargo test -p kodex-gateway runtime`
  - `cargo test -p kodex-gateway queue`
  - `cargo test -p kodex-gateway events`
- Run full backend verification before completion:
  - `cargo fmt`
  - `cargo test -p kodex-gateway`
  - `cargo test`
- Run static audits after the relevant milestones:
  - `wc -l apps/gateway/src/app_server_api.rs apps/gateway/src/store.rs` or adjusted module-directory equivalents to confirm the oversized files were split rather than renamed unchanged.
  - `rg -n "active_permission_profile_patch|apply_thread_settings_permissions_patch|apply_active_permission_profile_patch|save_thread_settings_permissions_patch" apps/gateway/src/routes/threads.rs apps/gateway/src/events.rs apps/gateway/src` to confirm only the shared settings projection helper owns that logic.
  - `rg -n '"starting"|"draining"|"syncing"|"streaming"|"unknown"' apps/gateway/src` to confirm runtime status literals are centralized or intentionally in SQL/tests.
- No frontend build, `$agent-browser` validation, OpenAPI regeneration, or app-server schema regeneration is expected unless implementation changes public DTOs, browser-visible API shapes, or the configured Codex app-server schema version.

## Risks And Open Questions

- Large Rust module splits can create noisy diffs. Keep the first pass move-only for each boundary, then make behavioral hardening in separate commits after tests prove the move.
- App-server adapter extraction must not blur the generated-schema contract. If an implementation chunk changes request/response parsing, verify the shape against `apps/gateway/app-server-schema/<version>/json` and the upstream app-server README before treating gateway behavior as authoritative.
- Store splitting can accidentally change SQL transaction boundaries or row mapper behavior. Keep SQL statements and public `Store` methods stable until the relevant domain tests are moved and passing.
- Permission overlay dedupe touches shared thread settings state. Route responses and app-server settings events must converge to the same typed `ThreadSummary` and raw payload projection so multiple browser clients do not see different settings truth from different event paths.
- Runtime status typing must remain backward-compatible with existing SQLite rows. Unknown persisted text should degrade to the enum's `Unknown` state and trigger existing refresh/idle fallback behavior rather than preventing gateway startup.
- P2/P3 audit items are intentionally out of scope for this plan: OpenAPI/schema drift guardrails, route test monolith splitting, smaller route DTO ownership cleanup, and any new handwritten API contract documentation.
