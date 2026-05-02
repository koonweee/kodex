# Composer Toolbar Persistence Plan

## Scope

Persist Codex-style composer toolbar selections across web app reloads without using browser `localStorage`.

This plan builds on the composer footer controls work. It does not add new toolbar controls, selectable context-window sizing, or a general config editor. It only adds the gateway and frontend behavior needed for model, reasoning effort, and inference speed defaults to round-trip through Codex app-server config.

## Status

Complete.

## Source Mapping

The implementation should follow Codex TUI/app-server behavior:

- App-server `config/read` exposes effective defaults including `model`, `model_reasoning_effort`, `approval_policy`, `approvals_reviewer`, `sandbox_mode`, and `service_tier`.
- App-server `config/value/write` and `config/batchWrite` can persist user config values. For this plan, Kodex should write only the scoped composer defaults it owns.
- Codex TUI persists model and reasoning selections to Codex config.
- Codex TUI persists Fast mode through Codex config.
- Codex TUI applies permissions presets as runtime/thread overrides. It does not silently persist a permissions preset just because the user selected it in the active session.
- Existing thread state remains authoritative when resuming or switching threads. `thread/resume` returns active `model`, `reasoningEffort`, `serviceTier`, `approvalPolicy`, `approvalsReviewer`, and sandbox state.

## Non-Goals

- Do not use `localStorage`, `sessionStorage`, IndexedDB, cookies, or other browser-only persistence for these settings.
- Do not create a broad config editor.
- Do not silently persist `Default permissions`, `Auto review`, or `Full access` from the toolbar.
- Do not store context usage. Context usage stays display-only and derived from app-server token usage events.
- Do not write raw sandbox or approval payloads as a stand-in for a named user preference.

## Principles

- App-server config is the durable source for new-thread composer defaults.
- Existing app-server thread state wins over durable defaults.
- Toolbar changes should be usable immediately even if persistence fails, but failures must be visible.
- Keep writes narrow and explicit: only `model`, `model_reasoning_effort`, and `service_tier` belong to this plan.
- Preserve generated OpenAPI as the frontend API contract.

## Current Problem

The composer footer can send selected model, reasoning effort, speed, and permissions to app-server, but the selections live only in frontend state. After a reload or new browser session, the toolbar falls back to frontend defaults instead of the user's Codex defaults or last persisted Codex-style model/speed choices.

Codex app-server already has config APIs and per-thread runtime state, so storing these choices in browser storage would create another source of truth.

## Reconciliation Model

Use this precedence order:

1. Active existing thread state from app-server.
2. Current in-memory toolbar selection made during this web session.
3. Effective defaults from app-server `config/read`.
4. Frontend hardcoded fallback only when app-server does not return usable defaults.

When the selected thread changes, replace toolbar display with that thread's active app-server state. When composing a new draft thread, initialize from the current in-memory selection if the user has edited it during this session; otherwise use app-server config defaults.

## Milestone 1: Gateway Composer Defaults Contract

Status: Complete

Failing tests first:

- Gateway reads effective composer defaults from app-server `config/read`.
- Gateway maps config `model` to the response model field.
- Gateway maps config `model_reasoning_effort` to the response effort field.
- Gateway maps config `service_tier` to the response service tier field.
- Gateway maps config permissions fields to a read-only permissions preset hint without persisting toolbar permissions.

Implementation:

- Add a small gateway endpoint for composer defaults, for example `GET /v1/composer-settings`.
- Resolve the selected project's `cwd` when available and pass it to app-server `config/read` so project-level config can participate.
- Return only the fields the toolbar needs: `model`, `effort`, `serviceTier`, and a derived `permissionsPreset` hint.
- Treat missing or unsupported app-server fields as `null` instead of inventing defaults in the gateway.
- Add DTO `ToSchema` coverage and generated OpenAPI support.

Exit conditions:

- Gateway tests cover `config/read` request shape and response mapping.
- The endpoint does not expose arbitrary config contents.
- OpenAPI includes the composer settings response shape.

## Milestone 2: Gateway Persistence Writes

Status: Complete

Failing tests first:

- Persisting a model writes only the app-server config `model` key.
- Persisting reasoning effort writes only `model_reasoning_effort`.
- Enabling Fast writes `service_tier: "fast"`.
- Disabling Fast clears or nulls `service_tier` according to the pinned app-server schema behavior.
- Permissions presets are not written by the composer persistence endpoint.

Implementation:

- Add a focused persistence endpoint, for example `PATCH /v1/composer-settings`, accepting optional `model`, `effort`, and `serviceTier`.
- Use app-server `config/batchWrite` when more than one field changes in one user action.
- Use `config/value/write` or `config/batchWrite` with the app-server-supported merge strategy for single-field writes.
- Pass app-server config write failures back to the frontend as actionable errors.
- Keep the request body narrow; do not accept arbitrary config key paths from the browser.

Exit conditions:

- Gateway tests verify exact app-server config write payloads.
- No permissions preset, sandbox policy, approval policy, or context usage is persisted through this endpoint.
- Generated OpenAPI and frontend types include the write request/response shape.

## Milestone 3: Frontend Startup and Validation

Status: Complete

Failing tests first:

- On web app startup, the toolbar initializes from `GET /v1/composer-settings` after model metadata loads.
- If the persisted model is unavailable, the toolbar falls back to the app-server/model-list default without crashing.
- If the persisted effort is unsupported by the selected model, the toolbar uses that model's default effort.
- No browser storage APIs are called for composer settings.

Implementation:

- Fetch composer settings alongside existing model metadata.
- Validate persisted `model` and `effort` against `GET /v1/models`.
- Preserve the current in-memory user selection while the user remains in the same web session.
- Avoid flashing misleading defaults while settings and model metadata are still loading.

Exit conditions:

- Reloading the web app restores persisted app-server model, effort, and Fast mode.
- Invalid or stale persisted settings degrade to safe visible defaults.
- Tests assert no `localStorage` dependency for toolbar persistence.

## Milestone 4: Thread-State Reconciliation

Status: Complete

Failing tests first:

- Selecting an existing thread displays that thread's app-server model, effort, service tier, and permissions state.
- Switching back to a draft/new-thread context restores the current new-thread composer selection.
- A completed turn response or resume event can reconcile toolbar state to the active app-server thread state.

Implementation:

- Keep separate concepts for durable composer defaults, new-thread draft settings, and active-thread settings.
- When a thread is selected, show active-thread settings rather than durable defaults.
- When no existing thread is selected, show new-thread draft settings derived from app-server config and any current-session edits.
- Continue to send permissions presets as thread/turn runtime overrides only.

Exit conditions:

- Existing threads do not get overwritten by last-used new-thread defaults.
- New draft threads use persisted model, effort, and Fast defaults unless the user changes them in-session.
- Permissions display reflects active thread state but remains non-persistent from the toolbar.

## Milestone 5: Persist-on-Selection UX

Status: Complete

Failing tests first:

- Changing model persists the model and compatible effort.
- Changing effort persists the effort.
- Toggling Fast persists service tier.
- Persistence failure shows a visible error while keeping the current in-memory selection for the active session.

Implementation:

- Persist model, effort, and Fast changes immediately after a user selection.
- Batch model and effort writes when changing model also resolves effort.
- Keep sends independent from persistence success: the current toolbar state still goes into the next `thread/start` or `turn/start` payload.
- Use compact error copy in the toolbar or existing app error surface.

Exit conditions:

- A reload after successful persistence restores the selected model, effort, and Fast mode.
- A reload after failed persistence falls back to app-server config defaults.
- Users can still send turns while a persistence request is in flight.

## Milestone 6: Regression and Documentation Pass

Status: Complete

Failing tests first:

- Existing composer footer tests still pass.
- Component tests cover startup hydration, stale model handling, thread-state precedence, and persistence failure.
- API client tests or typed call sites fail until regenerated OpenAPI types match the backend.

Implementation:

- Regenerate frontend OpenAPI types after backend DTO changes.
- Update frontend API wrappers for composer settings read/write.
- Add focused tests without expanding the toolbar implementation scope.
- Update README only if the new behavior changes user-visible setup, commands, or security assumptions.

Exit conditions:

- `cargo fmt` passes.
- Relevant `cargo test` coverage passes.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes if TypeScript or production bundle behavior changed.
- No local browser persistence is used for composer toolbar settings.
