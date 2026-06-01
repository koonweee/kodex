# App-server Resume/Fork And Settings Simplification Plan

## Status

Archived.

This plan is closed without completing its full original scope. The remaining fork/settings cleanup is not active; later native settings work covered most of the intended product value.

## Context

This plan follows the `0.130.0` app-server bump in [Codex 0.130.0 Bump And Full Turn History Plan](app-server-full-turn-history.md) and [App-server Live Config Refresh Plan](app-server-live-config-refresh.md).

Two follow-up improvements are now available:

- Use app-server `excludeTurns: true` on `thread/resume` and `thread/fork`, then rely on `thread/turns/list itemsView:"full"` only where a full selected-thread timeline is actually needed.
- Further narrow gateway-owned `thread_composer_settings` so app-server refreshed thread metadata is the normal authority, with gateway SQLite retained only for immediate response coherence, omitted app-server fields, and existing automation semantics.

The user preference remains: do not repair completed thread history by merging gateway event-store rows into snapshots. App-server remains the canonical thread history source.

## Current State

Relevant app-server contract:

- `apps/gateway/app-server-schema/0.130.0/json/v2/ThreadResumeParams.json` and `ThreadForkParams.json` both support `excludeTurns`, described as returning metadata/live state without populated `thread.turns` when the client will call `thread/turns/list`.
- `apps/gateway/app-server-schema/0.130.0/json/v2/ThreadReadParams.json` still exposes `includeTurns`.
- `apps/gateway/app-server-schema/0.130.0/json/v2/ThreadTurnsListParams.json` supports `itemsView: "notLoaded" | "summary" | "full"` and pagination.

Relevant gateway seams:

- `apps/gateway/src/app_server_api.rs`
  - `thread_read_full_history` already composes `thread/read includeTurns:false` with paged `thread_turns_list_full`.
  - `thread_read` still uses `thread/read includeTurns:true` for operational callers.
  - `thread_resume` and `thread_fork` currently call `require_extended_history(...)` but do not add `excludeTurns:true`.
  - `ThreadCommandResponse::from_payload` currently expects the command response shape to normalize enough data for route responses.
- `apps/gateway/src/routes/threads.rs`
  - `resume_thread` and `fork_thread` return `ThreadCommandResponse` to the frontend and then call `apply_thread_command_response_state`.
  - `fork_thread` still calls `save_forked_thread_composer_settings`.
  - `mark_thread_seen` still reads the old eager `thread_read` path to compute completed turn count.
  - `apply_thread_composer_settings` overlays stored SQLite settings on thread summaries, but only fills missing app-server fields after the live config work.
- `apps/gateway/src/store.rs`
  - `thread_composer_settings` stores model, reasoning effort, service tier, approval policy, approvals reviewer, and sandbox.
  - `save_thread_turn_options` writes turn options into the same table after submitted turns.
- `apps/gateway/src/automations.rs`
  - `latest_thread_options` intentionally reads `thread_composer_settings` for automation-generated turns.
  - This plan keeps that scheduler policy unchanged unless a separate product decision changes whether automations should inherit mutable app-server/global defaults.
- `apps/web/src/composer/useComposerSettingsState.ts` and `apps/web/src/composer/settings.ts`
  - Existing-thread controls prefer `ThreadSummary`/`rawPayload` metadata and reset local overrides when server thread settings change.
  - Draft settings remain browser-local until thread creation/submission.

## Goals

- Make resume/fork command responses cheaper and more consistent with selected-thread detail by avoiding eager turn population.
- Remove or narrow gateway setting writes that duplicate app-server-owned refreshed thread metadata.
- Preserve immediate UX coherence for created/resumed/forked/submitted threads when app-server command responses omit fields.
- Preserve existing automation behavior as an intentional retained gateway-owned policy.
- Keep the browser as a projection of gateway/app-server state; do not introduce browser-persisted existing-thread settings.

## Non-Goals

- Do not implement `thread/turns/items/list`; the current selected-thread detail path already uses full turn pages.
- Do not change automation product semantics from stored per-thread settings to mutable global/project defaults.
- Do not remove `thread_composer_settings` until every retained use has either moved to app-server state or has an explicit replacement.
- Do not introduce gateway event-store history merging.

## Milestones

### 1. Make Resume/Fork Use Metadata-Only Command Responses

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/threads.rs`, and route/adapter tests in `apps/gateway/src/routes/mod.rs`.

Work:

- Add an adapter helper or option so `thread_resume` and `thread_fork` send `excludeTurns: true`.
- Preserve existing caller-provided payload fields, including path/history/config overrides where schema permits them.
- Keep `persistExtendedHistory` only if the current startup/readiness contract still requires it, but document that the 0.130 schema marks it deprecated and ignored.
- Confirm `ThreadCommandResponse::from_payload` and `apply_thread_command_response_state` work with command responses whose `thread.turns` are omitted or empty.
- Update `thread_routes_map_read_resume_fork_and_archive` and adapter tests to assert `excludeTurns: true` on resume/fork.

Exit criteria:

- `cargo test -p kodex-gateway adapter_maps_thread_and_turn_methods`
- `cargo test -p kodex-gateway thread_routes_map_read_resume_fork_and_archive`
- Route tests prove resume/fork responses still return canonical `thread` metadata and no longer require populated turns.

### 2. Move Completed-Turn Consumers Off Eager `thread_read`

Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/routes/file_preview.rs`, `apps/gateway/src/routes/automations.rs`, `apps/gateway/src/queue.rs`, and `apps/gateway/src/app_server_api.rs`.

Work:

- Audit every remaining `CodexClient::thread_read` caller and classify it as one of:
  - metadata existence check,
  - runtime active-turn detection,
  - completed-turn count/read-state computation,
  - selected timeline detail.
- Replace metadata-only callers with `thread_read_summary`.
- Replace completed-turn count callers, such as `mark_thread_seen`, with a helper that reads paged full turns or a cheaper summary/count helper if app-server exposes one.
- Keep runtime active-turn detection correct. If active turn detection cannot be derived from summary metadata, either retain eager `thread_read` narrowly for `queue::reconcile_thread_runtime_from_app_server` or add a purpose-specific helper documented as an operational fallback.
- Keep file preview and automation thread validation on metadata-only reads.

Exit criteria:

- `rg -n "thread_read\\(" apps/gateway/src` shows only documented operational fallbacks, not general selected-thread/detail reads.
- Focused route tests cover mark-seen, file preview missing-thread behavior, automation target validation, and queue runtime reconciliation.
- `cargo test -p kodex-gateway thread_detail`
- `cargo test -p kodex-gateway thread_routes_map_read_resume_fork_and_archive`

### 3. Define Field-Level Gateway Settings Ownership

Scope: `apps/gateway/src/store.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/automations.rs`, and tests around composer settings in `apps/gateway/src/routes/mod.rs`.

Work:

- Add a field-by-field ownership table to this plan or implementation notes before deleting any persistence behavior:
  - `model`: app-server thread/config metadata when present; gateway fallback only for immediate response coherence and automations.
  - `reasoning_effort`: same as `model`.
  - `service_tier`: same as `model`.
  - `approval_policy`: app-server thread metadata when present; gateway fallback only where app-server omits it and automations need a stored policy.
  - `approvals_reviewer`: same as `approval_policy`.
  - `sandbox`: app-server thread metadata when present; gateway fallback only where app-server omits it and automations need a stored policy.
- Rename or document `ThreadComposerSettings` so it is no longer treated as canonical thread settings. Candidate names include `ThreadSubmittedOptions` or `ThreadSettingsFallback`.
- Keep `overlay_stored_thread_composer_settings` fill-only, and add tests that app-server fields win for every stored field, not only model/effort.
- Decide in code comments/tests that automations use the retained stored per-thread fallback as their current immutable scheduling policy.

Exit criteria:

- Backend tests prove app-server values win for model, effort, service tier, approval policy, approvals reviewer, and sandbox.
- Backend tests prove automation queued input still uses retained stored options.
- The retained SQLite settings purpose is named/documented so future work does not treat it as the canonical source.

### 4. Stop Copying Settings On Fork When App-server Provides Metadata

Scope: `save_forked_thread_composer_settings`, `fork_thread`, command response state sync, and fork tests.

Work:

- Change fork handling so gateway copies stored settings only for fields the fork response does not provide and only for fields that remain intentionally gateway-owned fallback.
- If the fork response includes app-server metadata for a field, do not persist the source thread's stored value over it for the forked thread.
- Update raw payload sync so response fields and `rawPayload.thread` remain consistent after fill-only fallback application.
- Strengthen `fork_thread_copies_gateway_owned_composer_settings` into two tests:
  - copy fallback fields when app-server omits them,
  - do not copy or overlay stale source fields when app-server returns canonical fork metadata.

Exit criteria:

- Fork route tests cover both missing-field fallback and app-server-owned-field precedence.
- `cargo test -p kodex-gateway fork_thread_copies_gateway_owned_composer_settings`
- `cargo test -p kodex-gateway stored_thread_settings_fill_only_missing_app_server_fields`

### 5. Frontend And Browser Convergence Checks

Scope: `apps/web/src/composer/useComposerSettingsState.ts`, `apps/web/src/composer/settings.ts`, `apps/web/src/App.mvp.composer-settings.test.tsx`, and browser validation.

Work:

- Keep existing-thread controls derived from app-server/gateway `ThreadSummary` metadata and raw payload.
- Add or keep frontend coverage that a local selected-thread override is replaced when refreshed server metadata arrives.
- Add frontend coverage for resume/fork responses that contain metadata-only command payloads, if current UI tests assume full turns.
- Use `$agent-browser` against the production or fullstack local app to validate:
  - selecting a thread after resume still shows the correct composer controls,
  - forked thread controls reflect app-server metadata when present,
  - two tabs converge after refreshed thread metadata arrives.

Exit criteria:

- `cd apps/web && npm test -- src/App.mvp.composer-settings.test.tsx`
- `cd apps/web && npm run build`
- `$agent-browser` smoke is completed or explicitly documented as blocked by local app-server/thread availability.

## Verification

Run these before marking the plan complete:

- `cargo fmt`
- `cargo test -p kodex-gateway adapter_maps_thread_and_turn_methods`
- `cargo test -p kodex-gateway thread_routes_map_read_resume_fork_and_archive`
- `cargo test -p kodex-gateway thread_detail`
- `cargo test -p kodex-gateway composer_settings`
- `cargo test -p kodex-gateway stored_thread_settings_fill_only_missing_app_server_fields`
- `cargo test -p kodex-gateway due_automation_queues_source_labeled_input_with_latest_thread_options`
- `cd apps/web && npm test -- src/App.mvp.composer-settings.test.tsx`
- `cd apps/web && npm run build`
- Full `cargo test -p kodex-gateway`; rerun with approval outside the sandbox if the MCP stdio test hits the known sandbox permission failure.

## Risks And Open Questions

- `persistExtendedHistory` is deprecated and ignored in the 0.130 schema, but current startup readiness still validates required experimental history behavior. Remove it only after a focused readiness/schema test proves doing so does not weaken persisted history coverage.
- Runtime active-turn reconciliation may still need a richer read than `thread_read_summary`. Keep that as a narrowly named operational fallback if app-server summary metadata cannot identify the active turn.
- Automations intentionally keep the current stored per-thread options policy. Changing them to mutable app-server/global defaults should be a separate product decision because scheduled prompts could silently start using different model/permission settings.
- If app-server omits a setting immediately after create/resume/fork/turn-start, the gateway can still fill the response for UX coherence, but it must not overwrite later app-server-owned metadata.
