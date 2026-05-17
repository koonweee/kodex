# Thread Client Surface Simplification Plan

## Status

Complete.

## Context

The TUI-aligned timeline work moved the important merge logic into the gateway, but several compatibility-era surfaces remain:

- `apps/web/src/timeline/reducer.ts` still supports legacy granular timeline events, optimistic user-message reconciliation, local active-turn inference, and text-based duplicate avoidance.
- `apps/gateway/src/events.rs` still constructs and internally names granular `timeline.item_delta`, `timeline.item_upsert`, `timeline.turn_upsert`, and `timeline.thread_status` events before converting visible transcript changes into canonical `timeline.projection_patch` events.
- `apps/gateway/src/app_server_api.rs::ThreadDetailResponse` and `ThreadCommandResponse` still expose overlapping `turns`, `timeline`, `liveState`, and `rawPayload` data, and `apps/web/src/App.tsx` reconstructs a `ThreadDetailResponse` from a resume command response.
- Composer, queue, active-turn, pending-user projection, and app-server error classification logic is split across `apps/web/src/composer/useComposerOrchestration.ts`, `apps/gateway/src/routes/turns.rs`, and `apps/gateway/src/queue.rs`.

The cleanup goal is to make the gateway the owner of lifecycle/timeline decisions and make web clients thin renderers. The source of truth remains upstream Codex TUI behavior for client sequencing, and app-server schemas/README remain the app-server wire contract.

## Current State

Code-established facts:

- `apps/web/src/timeline/useSelectedThreadTimeline.ts` already follows snapshot-then-stream and applies only `timeline.snapshot` and `timeline.projection_patch` as visible render events.
- `apps/web/src/events/stream.ts` still subscribes to operational `codex.notification` events plus canonical timeline events; account rate limits and thread metadata still depend on selected notification methods.
- `apps/web/src/timeline/reducer.snapshot.test.ts`, `reducer.lifecycle.test.ts`, `reducer.optimistic.test.ts`, and `reducer.performance.test.ts` still exercise legacy `timeline.item_*`, `timeline.turn_upsert`, `timeline.thread_status`, and optimistic reconciliation behavior.
- `apps/gateway/src/events.rs::append_timeline_event` persists `timeline.snapshot_required` cursors for transcript-like timeline events, then returns the non-persisted in-memory event to callers.
- `apps/gateway/src/timeline_projection.rs` is now an in-memory projection/session reducer, but its public API still uses the old `timeline_projection` name and patch kind.
- `apps/gateway/src/routes/threads.rs::get_thread` returns `ThreadDetailResponse`; `resume_thread` returns `ThreadCommandResponse` and then fills `live_state`, `turns`, and `timeline` via `attach_thread_detail_to_command_response`.
- `apps/web/src/App.tsx::applyResumeTimelineSnapshot` builds a local `ThreadDetailResponse` out of `ThreadCommandResponse`, which keeps resume snapshot behavior separate from normal `GET /v1/threads/{id}` snapshot behavior.
- `apps/gateway/src/routes/turns.rs::submit_thread_input` already owns start-versus-steer routing for normal composer submits, but `start_turn`, `steer_turn`, and queue endpoints still expose lower-level lifecycle paths.
- `apps/gateway/src/queue.rs` still uses `thread_runtime_state` as a drain claim/coordination table and keeps active-turn discovery helpers separate from `routes/turns.rs`.

Constraints and settled decisions:

- Do not add redundant durable transcript/message persistence outside app-server.
- Gateway may persist coordination state such as queued inputs, queue drain claims, approvals, read state, pins, and metadata.
- Frontend API types must come from generated OpenAPI artifacts.
- Shared lifecycle behavior must be correct across two same-user tabs; if correctness depends on React-only state, move the source of truth to gateway.
- Hard cuts are allowed when they reduce bug surface and preserve correctness.

## Target Shape

- One public renderer contract: canonical gateway snapshot plus canonical gateway projection patch.
- Web timeline state stores gateway rows by gateway ids and revisions; it does not derive row identity, active turn, lifecycle state, or duplicate suppression from raw app-server notifications.
- Gateway event naming distinguishes:
  - renderer events: canonical timeline snapshots/patches,
  - operational events: approvals, queues, automations, pins, metadata, account state,
  - diagnostic/debug events: raw or cursor-only app-server observations.
- Thread detail and resume responses stop forcing the frontend to merge command, raw turns, and timeline overlays.
- Composer submits intent to gateway; gateway decides start, steer, queue, or retry using current gateway/app-server state.

## Non-Goals

- Do not redesign timeline visual presentation.
- Do not remove the app-server raw payloads from backend adapter internals where they are needed to parse future schema variants.
- Do not remove queue persistence; queued inputs are coordination state, not transcript history.
- Do not make automations change from their current queue-first behavior unless a separate product decision asks for that.
- Do not expose Kodex beyond localhost/trusted VPN assumptions.

## Milestones

### 1. Thin Frontend Timeline Reducer

Scope: `apps/web/src/timeline/reducer.ts`, `apps/web/src/timeline/state.ts`, `apps/web/src/timeline/batch.ts`, `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/useReadonlyThreadTimeline.ts`, and timeline reducer tests.

Work:

- Delete visible-row handling for legacy granular event kinds from the production reducer:
  - `timeline.item_delta`
  - `timeline.item_upsert`
  - `timeline.turn_upsert`
  - `timeline.thread_status`
- Keep only:
  - `applyTimelineSnapshot` for canonical `ThreadDetailResponse.timeline`,
  - `applyTimelineProjectionPatch` for canonical gateway patches,
  - diagnostic warning/error handling for debug display.
- Remove optimistic user-message APIs from production timeline state unless a current call site still needs a strictly browser-local failed-upload/draft affordance.
- Replace text/image matching and fractional display-order logic with gateway-row id replacement and revision guards only.
- Rename frontend state fields away from persistence-era terminology where practical, for example `projectionRevision` to `viewRevision`.
- Split tests so canonical reducer tests remain, while deleted legacy behavior tests are removed instead of preserved as compatibility requirements.

Exit criteria:

- `rg "timeline\\.item_delta|timeline\\.item_upsert|timeline\\.turn_upsert|timeline\\.thread_status" apps/web/src/timeline apps/web/src/App*.test.tsx` finds no production visible-render dependency.
- `rg "addOptimisticUserMessage|updateOptimisticUserMessage|removeOptimisticUserMessage" apps/web/src` finds no production imports.
- Focused tests pass:
  - `cd apps/web && npm test -- src/timeline/reducer.snapshot.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/batch.test.ts`
  - `cd apps/web && npm run build`

### 2. Simplify Gateway Event Taxonomy

Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/timeline_projection.rs`, `apps/gateway/src/approvals.rs`, `apps/gateway/src/routes/events.rs` behavior in `apps/gateway/src/routes/mod.rs` tests, and `apps/web/src/events/stream.ts`.

Work:

- Rename or wrap `timeline_projection` APIs to describe their current role as the gateway thread session/timeline view reducer. A full file rename is acceptable if it keeps diffs clearer.
- Stop exposing granular transcript event names as normal live-render event concepts. Gateway internals may use private helper names, but SSE-visible rendering should remain canonical snapshots/patches plus `timeline.snapshot_required`.
- Make event constants explicit by category:
  - renderer: canonical timeline patch/snapshot-required,
  - operational: approvals, queue, automation, pin/upsert, thread metadata, account/MCP/skills,
  - diagnostic: cursor-only app-server notifications and debug-only replay.
- Keep `codex.notification` only for operational notification methods currently consumed by web, such as account rate limits and thread metadata, or move those to named gateway events with focused tests.
- Audit selected-thread replay so cursor replay cannot reintroduce stale transcript rows; replay should send only operational events plus canonical renderer patches or snapshot-required markers.

Exit criteria:

- `apps/web/src/events/stream.ts` subscribes only to canonical renderer events and named operational events required by the app.
- Backend tests cover that transcript-like app-server notifications do not become durable replayable visible timeline rows.
- Backend tests cover selected-thread SSE replay after cursor for canonical patches/snapshot-required only.
- `cargo test events` and relevant route SSE tests pass.

### 3. Collapse Thread Detail And Resume DTO Overlap

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/api.rs`, `apps/web/src/api/client.ts`, `apps/web/src/api/generated/schema.ts`, `apps/web/src/App.tsx`, thread cache helpers, and snapshot tests.

Work:

- Introduce a renderer-facing response shape if needed, for example `ThreadViewResponse`, containing:
  - `thread`,
  - `liveState`,
  - canonical `timeline`,
  - optional raw/debug app-server data only behind an explicit debug field if still needed.
- Make `GET /v1/threads/{threadId}` and `POST /v1/threads/{threadId}/resume` return the same renderer-facing shape for selected-thread rendering.
- Remove normal frontend reliance on `ThreadDetailResponse.turns` and `ThreadCommandResponse.turns`.
- Delete `apps/web/src/App.tsx::applyResumeTimelineSnapshot` by making resume and snapshot loading go through one path.
- Keep adapter-internal app-server raw response parsing in Rust, but avoid exposing raw `turns` as a frontend merge surface unless a debug-only route needs them.
- Regenerate OpenAPI and frontend generated types.

Exit criteria:

- `rg "response\\.turns|\\.turns" apps/web/src/App.tsx apps/web/src/timeline` shows no normal renderer dependency on raw turns.
- `GET /v1/threads/{id}` and resume route tests assert the same canonical timeline contract.
- `cd apps/web && npm run generate:api` updates `apps/web/src/api/generated/schema.ts`.
- `cargo test` passes relevant gateway API/route tests.

### 4. Consolidate Composer, Queue, And Active-Turn Lifecycle

Scope: `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/queue.rs`, `apps/gateway/src/automations.rs`, `apps/gateway/src/store.rs` runtime-state helpers, `apps/web/src/composer/useComposerOrchestration.ts`, composer tests, queue tests, and route tests.

Work:

- Extract shared gateway helpers for:
  - current active-turn lookup from `state.thread_sessions` with app-server read fallback,
  - app-server "no active turn" and "non-steerable" error classification,
  - pending user projection insertion and canonical patch emission,
  - pending skill mention cleanup on command failure.
- Make normal composer submit use one gateway route, `POST /v1/threads/{threadId}/input`, for start/steer/queue decisions.
- Keep lower-level `turns`, `steer`, and `interrupt` routes only where an existing internal or external caller truly needs them; otherwise narrow or remove them from frontend use.
- Clarify `thread_runtime_state` as queue-drain coordination only:
  - no command routing may trust durable `active_turn_id`,
  - draining claims can remain durable because they coordinate queue workers after restarts.
- In web, remove composer lifecycle branching that treats local `activeSelectedTurnId` as authoritative for shared routing. It may still drive stop-button visibility and local affordances.
- Add same-user two-tab tests for stale local active-turn state:
  - one tab has stale idle state while another tab is active,
  - gateway steers or queues based on current gateway/app-server state,
  - both tabs converge through SSE/snapshot without duplicate user rows.

Exit criteria:

- `rg "is_no_active_turn_error|is_non_steerable_error|record_pending_user_projection|active_turn_id_for_submit|current_active_turn_id" apps/gateway/src` shows shared helpers rather than divergent copies.
- `rg "get_thread_runtime_state\\(|active_turn_id" apps/gateway/src/routes apps/gateway/src/queue.rs` shows durable runtime state is not used as active-turn routing truth.
- Focused gateway queue/turn tests pass.
- Focused composer tests pass:
  - `cd apps/web && npm test -- src/App.mvp.composer-input.test.tsx src/composer/ComposerPanel.test.tsx`

### 5. End-To-End Verification And Browser Checks

Scope: full backend/frontend verification plus `$agent-browser` manual checks against a dev server.

Work:

- Run backend and frontend verification:
  - `cargo fmt`
  - `cargo test`
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`
- Start full-stack dev with the gateway and Vite frontend.
- Use `$agent-browser` to verify:
  - new thread first message renders once,
  - resume idle thread renders history once and next submit starts correctly,
  - resume active thread continues live rendering without duplicate assistant/user rows,
  - queued steer UI still behaves correctly,
  - two browser contexts converge after one misses live events and later reloads/switches back.

Exit criteria:

- Automated verification passes or any unrelated flake is isolated with a focused passing rerun.
- Browser checks cover new thread, idle resume, active resume, queue/steer, and two-tab convergence.
- `plans/index.md` and this plan are updated to reflect implementation status when work starts or completes.

## Verification

- Backend:
  - `cargo fmt`
  - `cargo test`
- Frontend:
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`
  - regenerate API types after DTO changes with a running gateway: `cd apps/web && npm run generate:api`
- Browser:
  - Use `$agent-browser` against the local dev server for the lifecycle scenarios listed in Milestone 5.

## Risks And Open Questions

- Raw-turn removal may affect debug workflows hidden in broad app tests. Resolve by either moving raw data to an explicit debug route/field or updating tests to assert the canonical renderer contract.
- Some operational consumers still listen to `codex.notification`, especially account rate limits and thread metadata. During Milestone 2, either preserve only those methods or replace them with named gateway events in the same change.
- `thread_runtime_state` currently doubles as a queue drain claim. The cleanup should narrow that table's meaning instead of deleting it prematurely.
- Automations should stay queue-first. Changing scheduler semantics is out of scope.
