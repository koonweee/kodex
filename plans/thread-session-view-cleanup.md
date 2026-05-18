# Thread Session View Cleanup Plan

## Status

Complete.

## Context

The TUI-aligned thread work moved transcript convergence into the gateway, but the remaining names still describe an older architecture:

- `apps/gateway/src/timeline_projection.rs` is now the in-memory selected-thread/session view reducer. It owns active turn state, pending request overlays, live app-server item updates, canonical snapshots, and live renderer patches.
- The public SSE event kind is still `timeline.projection_patch`, but the Rust module, type names, route tests, and imports now make readers think there is a separate projection persistence layer.
- The frontend no longer routes composer sends through low-level turn APIs. `apps/web/src/composer/useComposerOrchestration.ts` calls `submitThreadInput`, `steerQueuedInput`, queued retry/delete APIs, and `interruptTurn`.
- `apps/web/src/api/client.ts` still exposes stale `startTurn` and direct `steerTurn` wrappers for `/v1/threads/{threadId}/turns` and `/v1/threads/{threadId}/turns/{turnId}/steer`, even though normal web clients should not decide start-versus-steer from local state.

This cleanup should preserve the gateway-owned lifecycle model: the browser submits intent, the gateway decides start/steer/queue based on current gateway/app-server state, and the browser renders canonical thread views.

## Current State

Code-established facts:

- `apps/gateway/src/lib.rs` exports `pub mod timeline_projection`.
- `apps/gateway/src/api.rs` imports `timeline_projection::{ThreadSessionStore, TimelineProjectionPatch}` and stores `AppState::thread_sessions`.
- `apps/gateway/src/events.rs`, `approvals.rs`, `turn_lifecycle.rs`, `queue.rs`, `routes/threads.rs`, `routes/self_control.rs`, and route tests call `timeline_projection::*` helpers.
- `apps/gateway/src/timeline_projection.rs` defines:
  - `TIMELINE_PROJECTION_PATCH_KIND = "timeline.projection_patch"`,
  - `TimelineProjectionPatch`,
  - `ThreadSessionStore`,
  - private `ThreadSessionView`,
  - reducer functions such as `record_item_delta`, `record_item_upsert`, `record_turn_status`, `record_pending_user_input`, and `build_thread_timeline`.
- `apps/web/src/api/client.ts` exports `startTurn`, `submitThreadInput`, `interruptTurn`, and `steerTurn`.
- `apps/web/src/composer/useComposerOrchestration.ts` imports only `submitThreadInput`, `interruptTurn`, and queued-input APIs; it does not import `startTurn` or direct `steerTurn`.
- Existing frontend tests still include low-level `/turns` mock entries in `apps/web/src/App.mvp.composer-input.test.tsx`, mostly as stale fixtures or stop/interrupt coverage.

Constraints:

- Do not change the app-server wire contract without checking checked-in schemas/README.
- Generated OpenAPI remains the public gateway contract; frontend types come from `apps/web/src/api/generated/schema.ts`.
- Hard cuts are acceptable when they reduce surface area and preserve correctness.
- `interruptTurn` remains frontend-relevant because stop is a direct user command for a known active turn.
- Do not add durable transcript/message persistence outside app-server.

## Target Shape

- Gateway code uses a name like `thread_session_view` for the in-memory thread view reducer.
- The public renderer event can remain `timeline.projection_patch` for compatibility with the canonical timeline event taxonomy, but internal Rust names should make clear this is a thread view/session patch, not a second persistence source.
- Frontend handwritten API helpers expose the gateway-owned lifecycle route:
  - keep `submitThreadInput`,
  - keep `interruptTurn`,
  - keep queued-input helpers,
  - remove `startTurn` and direct `steerTurn` from normal web client helpers.
- Tests and fixtures should stop mocking or asserting low-level turn start/steer unless they intentionally cover the gateway route itself.

## Non-Goals

- Do not remove backend `/v1/threads/{threadId}/turns` or `/steer` routes in this plan. They may still be useful for external/manual callers, API compatibility, or focused backend coverage.
- Do not rename the SSE event kind away from `timeline.projection_patch` unless a separate API/event taxonomy migration explicitly chooses that.
- Do not redesign queued-input behavior or stop/interrupt behavior.
- Do not rework the timeline visual layout beyond updating names and tests affected by the API cleanup.

## Milestones

### 1. Rename Gateway Session View Module

Scope: `apps/gateway/src/timeline_projection.rs`, `apps/gateway/src/lib.rs`, `apps/gateway/src/api.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/approvals.rs`, `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/routes/self_control.rs`, `apps/gateway/src/queue.rs`, and route tests in `apps/gateway/src/routes/mod.rs`.

Work:

- Move `apps/gateway/src/timeline_projection.rs` to `apps/gateway/src/thread_session_view.rs`.
- Update `pub mod timeline_projection` to `pub mod thread_session_view`.
- Rename imports and call sites from `timeline_projection::...` to `thread_session_view::...`.
- Rename internal type/function names where they improve clarity:
  - `TimelineProjectionPatch` -> `ThreadViewPatch` or `ThreadSessionViewPatch`,
  - `TIMELINE_PROJECTION_PATCH_KIND` -> `THREAD_VIEW_PATCH_EVENT_KIND`,
  - `projection_patch_for_thread` -> `view_patch_for_thread` or `patch_for_thread_view`.
- Keep the serialized event kind value `"timeline.projection_patch"` unless a separate event-name migration is planned.
- Regenerate OpenAPI and frontend generated types if public schema names change.

Exit criteria:

- `rg "timeline_projection" apps/gateway/src` finds no live module/import references.
- `rg "TimelineProjectionPatch|projection_patch_for_thread|TIMELINE_PROJECTION_PATCH_KIND" apps/gateway/src apps/web/src` finds only intentional wire-event references or no matches, depending on final naming.
- `cargo fmt` passes.
- Focused backend tests pass:
  - `cargo test thread_session_view -q`
  - `cargo test events -q`
  - relevant route tests that assert selected-thread SSE patches.

### 2. Narrow Frontend Turn API Helpers

Scope: `apps/web/src/api/client.ts`, composer orchestration/tests, fake gateway fixtures, and any frontend code importing generated low-level turn paths.

Work:

- Remove handwritten `startTurn` from `apps/web/src/api/client.ts`.
- Remove handwritten direct `steerTurn` from `apps/web/src/api/client.ts`.
- Keep `submitThreadInput` as the only normal composer submit helper.
- Keep `interruptTurn` because stop remains a direct active-turn command.
- Audit tests for stale low-level route fixtures:
  - remove unused `"POST /v1/threads/{threadId}/turns"` mocks,
  - remove unused direct `"POST /v1/threads/{threadId}/turns/{turnId}/steer"` mocks,
  - keep `"POST /v1/threads/{threadId}/turns/{turnId}/interrupt"` mocks for stop tests.
- Confirm queued active-turn UI still uses `steerQueuedInput`, not direct `steerTurn`.

Exit criteria:

- `rg "startTurn|steerTurn" apps/web/src --glob '!api/generated/schema.ts'` returns no normal frontend helper/call-site references.
- `rg '"/v1/threads/.*/turns"|"/v1/threads/.*/steer"' apps/web/src` shows only intentional interrupt tests or generated schema paths.
- Focused frontend tests pass:
  - `cd apps/web && npm test -- src/App.mvp.composer-input.test.tsx src/composer/ComposerPanel.test.tsx src/timeline/batch.test.ts src/timeline/derive.test.ts`
- `cd apps/web && npm run build` passes.

### 3. Contract And Naming Verification

Scope: generated OpenAPI, frontend generated schema, plan/index docs, and browser-visible composer lifecycle.

Work:

- If Rust public schema names changed, regenerate frontend OpenAPI types with a current gateway:
  - start gateway on a temporary port,
  - run `cd apps/web && npm run generate:api` or the repo’s direct `openapi-typescript` command,
  - stop the temporary gateway.
- Update any tests that refer to the old schema/type name.
- Use `$agent-browser` against a fresh local gateway/Vite stack to smoke-check:
  - composer loads,
  - text entry enables send,
  - stop button path remains available when an active turn is represented by fixture/dev state if practical.

Exit criteria:

- `apps/web/src/api/generated/schema.ts` matches the current gateway OpenAPI if schema names changed.
- `cargo test -q` passes, using escalation if required for the MCP integration test.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.
- `$agent-browser` smoke verifies the composer still uses the thin gateway-owned route surface for user-visible send/stop behavior where the local environment can exercise it.

## Verification

- Backend:
  - `cargo fmt`
  - `cargo test thread_session_view -q`
  - `cargo test events -q`
  - `cargo test -q`
- Frontend:
  - `cd apps/web && npm test -- src/App.mvp.composer-input.test.tsx src/composer/ComposerPanel.test.tsx`
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`
- Static audits:
  - `rg "timeline_projection" apps/gateway/src`
  - `rg "TimelineProjectionPatch|projection_patch_for_thread|TIMELINE_PROJECTION_PATCH_KIND" apps/gateway/src apps/web/src`
  - `rg "startTurn|steerTurn" apps/web/src --glob '!api/generated/schema.ts'`
- Browser:
  - `$agent-browser` smoke against a local dev stack for composer load, send affordance, and stop affordance when testable.

## Risks And Open Questions

- Renaming `TimelineProjectionPatch` to `ThreadViewPatch` changes generated frontend type names. This is acceptable for a hard cut, but the implementation should do the rename and API generation in one coherent commit.
- Backend low-level turn routes remain public in this plan. Removing or hiding them from OpenAPI is a separate API policy decision because external/local clients may already use them.
- `timeline.projection_patch` is still a reasonable wire event name because it is part of the canonical renderer event taxonomy. Renaming the wire event would require updating SSE clients, route tests, and replay semantics and is intentionally out of scope here.
- There are currently uncommitted fixes in `apps/gateway/src/timeline_projection.rs` and frontend timeline files. Implementers should either commit those first or carefully include them in the rename to avoid losing the late-delta and work-row-order fixes.
