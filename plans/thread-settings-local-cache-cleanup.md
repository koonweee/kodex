# Thread Settings Local Cache Cleanup Plan

## Context

- Existing-thread model, reasoning effort, and service tier should be app-server-owned thread settings, matching Codex TUI behavior and the app-server `thread/settings/update` contract.
- Kodex currently has a second durable source in gateway SQLite: `thread_composer_settings.model`, `thread_composer_settings.reasoning_effort`, and `thread_composer_settings.service_tier`.
- That local table can resurrect stale settings such as `xhigh` after the user changes a thread to `high`, especially when gateway overlays stored values onto app-server thread summaries or automation paths convert stored settings back into turn options.
- New-thread defaults remain app-server config defaults through `GET /v1/composer-settings`; this cleanup only removes gateway-local durable ownership for existing-thread model, reasoning, and speed.

## Current State

- Frontend selected-thread settings are derived from `ThreadSummary` in `apps/web/src/composer/settings.ts` via `composerSettingsFromThread`.
- Frontend selected-thread settings changes call `PATCH /v1/threads/{threadId}/settings` through `useComposerSettingsState` in `apps/web/src/composer/useComposerSettingsState.ts`.
- Frontend normal selected-thread sends intentionally omit turn options unless there is a same-tab selected-thread override in `apps/web/src/composer/useComposerOrchestration.ts`.
- Gateway forwards settings changes to app-server in `update_thread_settings` in `apps/gateway/src/routes/threads.rs`, then reads the app-server thread summary.
- Gateway overlays local thread composer settings in `apply_thread_composer_settings` and `overlay_stored_thread_composer_settings` in `apps/gateway/src/routes/threads.rs`.
- Gateway local storage currently persists model/reasoning/speed in `ThreadComposerSettings` and `thread_composer_settings` in `apps/gateway/src/store.rs`.
- Gateway automations currently use `latest_thread_options` in `apps/gateway/src/automations.rs`, which reads local thread composer settings and can include stale model/reasoning/speed in queued turn options.
- Upstream Codex TUI keeps `ThreadSessionState.model` and `ThreadSessionState.reasoning_effort`, sends updates through `thread/settings/update`, and applies `thread/settings/updated` back to cached session state. It does not keep an extra durable client-side thread model cache.

## Milestones

### 1. Remove Local Model/Reasoning/Speed Ownership

- Scope: `apps/gateway/src/store.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/automations.rs`.
- Work:
  - Replace `ThreadComposerSettings` with a more accurate internal type such as `ThreadLocalSettingsOverlay` or `ThreadExecutionOverrides`.
  - Remove `model`, `reasoning_effort`, and `service_tier` from the internal overlay type.
  - Remove `ThreadComposerSettings::from_turn_options`, `ThreadComposerSettings::to_turn_options`, and `Store::save_thread_turn_options`.
  - Update `overlay_stored_thread_composer_settings` so it never writes `thread.model`, `thread.reasoning_effort`, `thread.service_tier`, or their raw-payload fields from gateway-local storage.
  - Update `save_thread_creation_options` so it no longer persists model/reasoning/speed locally; thread creation should still send those options to app-server and overlay the immediate create response only when app-server omits fields in the response.
  - Update `save_thread_settings_permissions_patch` in both `routes/threads.rs` and `events.rs` to use the renamed local overlay type and only retain fields gateway still owns as compatibility fallback.
  - Update `automations::latest_thread_options` so automation turns do not inject local model/reasoning/speed; automations should rely on the loaded thread's app-server settings unless retained local execution overrides such as permissions/sandbox are explicitly needed.
- Exit criteria:
  - A focused backend test proves a stored stale local `xhigh` value does not override an app-server `high` thread summary.
  - A focused backend automation test proves automation `turn/start` omits stale local model/reasoning/speed while preserving any intentionally retained execution override fields.

### 2. Migrate And Clean The SQLite Schema

- Scope: `apps/gateway/src/store.rs` schema initialization and migration tests.
- Work:
  - Add a migration path from `thread_composer_settings` to a renamed table such as `thread_local_settings_overlays`.
  - Copy only retained local overlay columns, such as `thread_id`, `approval_policy`, `approvals_reviewer`, `permissions`, `sandbox_json`, `created_at`, and `updated_at`.
  - Drop or retire the old `thread_composer_settings` table so stale `model`, `reasoning_effort`, and `service_tier` values are removed from local DBs instead of becoming inert hidden data.
  - Add helper code for table-existence checks if needed, following the existing `add_column_if_missing` migration style.
  - Update `file_database_migration_creates_tables_and_enables_wal` and store round-trip tests for the new table/type.
- Exit criteria:
  - A migration test creates an old-style `thread_composer_settings` table containing `xhigh`, reopens the store, and verifies the new table contains only retained local overlay fields.
  - Existing in-memory and file-backed store tests pass.

### 3. Keep App-Server Thread Settings Authoritative End To End

- Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/routes/mod.rs`.
- Work:
  - Add route/event tests around `thread/settings/updated` normalization where app-server reports `reasoningEffort: "high"` while local migrated/retained overlay state previously had `xhigh`.
  - Ensure `apply_thread_summary_state` can still apply pins, notifications, read state, and retained local permission/sandbox fallback without touching app-server model/reasoning/speed.
  - Verify `sync_thread_command_response` and raw response synchronization do not reinsert local model/reasoning/speed values.
  - Keep `CreateThreadRequest`, `ThreadSettingsUpdateRequest`, and `TurnStartOptions` API DTOs unchanged; the public API still accepts model/effort/serviceTier and forwards them to app-server.
- Exit criteria:
  - Backend tests demonstrate `thread/read`, `thread/list`, `thread/settings/updated`, and create/resume paths expose app-server model/reasoning/speed without local stale overlay.
  - No OpenAPI schema change is required unless internal cleanup unexpectedly changes public DTOs; if it does, regenerate and commit frontend API types.

### 4. Frontend Regression Coverage And UI Smoke

- Scope: `apps/web/src/composer/settings.ts`, `apps/web/src/composer/useComposerSettingsState.ts`, `apps/web/src/composer/useComposerOrchestration.ts`, closest frontend tests.
- Work:
  - Keep frontend behavior unchanged for new draft threads: hydrate app-server defaults from `/v1/composer-settings`, then send those settings in `createThreadOptions`.
  - Keep selected existing threads using `ThreadSummary.model`, `ThreadSummary.reasoningEffort`, and `ThreadSummary.serviceTier`.
  - Add or update focused tests to cover that selected-thread sends omit turn options when app-server thread settings are already authoritative, including when stale raw payload fields are present.
  - Keep existing per-turn option builder coverage for explicit override payload construction without forcing browser sends to duplicate already-persisted app-server thread settings.
  - Add an `$agent-browser` smoke scenario against a running app: select a thread whose app-server summary reports `high`, verify the composer settings show `high`, submit a normal turn, and confirm the request does not carry stale `xhigh`.
- Exit criteria:
  - `cd apps/web && npm test` focused composer/settings coverage passes.
  - `$agent-browser` validation confirms the browser-observable settings flow does not display or submit stale local `xhigh`.

### 5. Documentation And Review Gate

- Scope: `plans/index.md`, optional README/AGENTS updates only if workflow or setup changes.
- Work:
  - Keep this plan status current in `plans/index.md`.
  - Update `README.md` only if commands, setup, or user-visible behavior documentation changes.
  - Update `AGENTS.md` only if contributor rules around thread settings ownership need to be clarified beyond the existing multi-client ownership guidance.
  - Run an independent review pass before marking the implementation complete.
- Exit criteria:
  - `cargo fmt` passes.
  - Focused `cargo test` targets for store migrations, thread settings routes/events, and automations pass.
  - Relevant frontend tests pass.
  - Browser smoke is recorded, or any inability to run it is explicitly documented with the remaining risk.
  - Independent review finds no major issue, or all major findings are fixed.

## Verification

- Backend:
  - `cargo fmt`
  - `cargo test -p kodex-gateway thread_settings`
  - `cargo test -p kodex-gateway thread_composer`
  - `cargo test -p kodex-gateway automation`
  - `cargo test -p kodex-gateway migration`
- Frontend:
  - `cd apps/web && npm test -- settings`
  - `cd apps/web && npm test -- composer`
- Browser:
  - Start the full stack with the repository's normal dev workflow.
  - Use `$agent-browser` to verify selected-thread settings display app-server `high` and ordinary sends do not include stale `xhigh`.

## Risks And Open Questions

- SQLite table cleanup must preserve retained local permission/sandbox fallback fields for existing users. Resolve by adding an old-table migration fixture in `apps/gateway/src/store.rs` tests.
- Automations currently assert model/reasoning are copied from local thread settings. This should change: automations should rely on app-server thread state for model/reasoning and only send retained local execution overrides if those are still required.
- If app-server ever omits model/reasoning from old thread summaries, Kodex should show default/unknown rather than filling from stale gateway-local state. That is an intentional behavior change to avoid incorrect cross-client state.
