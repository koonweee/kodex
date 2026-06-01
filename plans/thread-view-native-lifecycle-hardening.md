# Thread View Native Lifecycle Hardening Plan

## Status

Proposed.

## Context

Kodex already completed the hard cut away from durable gateway transcript replay: selected-thread loading reads app-server metadata plus `thread/turns/list`, live notifications update an in-memory `thread_view`, and browsers render `ThreadViewResponse.timeline` plus `thread_view.patch`.

This plan is a follow-on cleanup for the remaining places where the code still looks or behaves like Kodex owns a second transcript/history model. The target is narrower than the completed timeline simplification plans: keep `thread_view` as a gateway in-memory renderer contract for web/mobile clients, while app-server remains the durable owner of threads, turns, items, and history.

Grounding from the repo and app-server contract:

- `apps/gateway/app-server-schema/0.135.0/json/ClientRequest.json` defines native `thread/read`, `thread/resume` with `excludeTurns`, and `thread/turns/list` with `cursor`, `sortDirection`, `itemsView`, and `limit`.
- `apps/gateway/app-server-schema/0.135.0/json/v2/ThreadReadResponse.json` documents that `thread.turns` is only populated on specific native read/resume/fork responses, and `TurnItemsView::full` means app-server returned every persisted item available for that turn.
- The upstream app-server README describes Thread, Turn, and Item as the native conversation primitives and says clients drive turns through app-server APIs and stream progress through app-server notifications.
- Upstream TUI behavior is a client sequencing reference, but the generated schema and app-server README remain the wire contract per `AGENTS.md`.

## Current State

Backend code-established facts:

- `apps/gateway/src/thread_view.rs` stores per-thread `ThreadView` sessions in memory, including `history_turns`, `history_page`, `turns`, `items`, `terminal_turn_ids`, `active_turn_id`, `live_state`, and pending request summaries.
- `ThreadView::refresh_from_base` merges app-server snapshot turns with existing in-memory live items using text matching, item-id matching, live-text preservation, context-compaction pruning, and synthetic turn insertion from items.
- `build_thread_timeline_window` and `prepend_thread_timeline_page` are called from `apps/gateway/src/routes/threads.rs::apply_thread_detail_response_state_with_merge` after `thread_read_history_window` or `thread_read_history_page`.
- `apps/gateway/src/events.rs` persists compact `thread_view.cursor` rows for transcript-like app-server notifications, then emits non-persisted synthetic `thread_view.patch` events from the in-memory store.
- The event code still uses transitional source names such as `timeline.item_delta`, `timeline.item_upsert`, `timeline.turn_upsert`, and `timeline.thread_status` for cursor metadata and tests.
- `thread/compacted` reconciliation currently calls `thread_read` with `includeTurns:true`, while normal selected-thread loading uses the paged `thread_read_history_window` path.
- `apps/gateway/src/app_server_api.rs` still exposes OpenAPI schemas for `TimelineItemDeltaPayload`, `TimelineTurnUpsertPayload`, and `TimelineThreadStatusPayload`, even though visible rendering is now `ThreadTimelineRow` snapshots and `ThreadViewPatch` rows.
- `apps/gateway/src/events_replay.rs` replays operational events plus validated `thread_view.patch`, and converts missed cursor or invalid patch replay into `thread_view.refresh_required`.

Frontend code-established facts:

- `apps/web/src/timeline/useSelectedThreadTimeline.ts` loads `GET /v1/threads/{threadId}`, then subscribes with the returned `viewRevision`; `thread_view.refresh_required` triggers a snapshot refetch.
- `apps/web/src/timeline/reducer.ts` applies only `thread_view.patch` as visible live transcript input and ignores raw `timeline.item_delta`, but it still contains stale raw-event-style helpers such as `applyPresentedCanonicalItem`, `withCanonicalSnapshotLiveState`, and generic item merge code.
- `applyTimelineHistoryWindow` prepends older app-server windows while preserving the existing selected-thread state, so frontend history-window logic must stay aligned with the gateway's loaded-window semantics.
- `addOptimisticUserMessage`, `markOptimisticUserMessageSent`, and `removeOptimisticUserMessage` remain used from `apps/web/src/App.tsx` as browser-local send affordances; they must not become a shared transcript source.

Existing tests already protect important invariants:

- `apps/gateway/src/thread_view/tests.rs` covers bounded turn patches, item completion not completing a turn, late delta suppression after terminal turn status, stale active snapshot text preservation, older-page prepends, and context-compaction pruning.
- `apps/gateway/src/events/tests.rs` covers cursor-only persistence, bounded completed-turn head reconciliation through `thread/turns/list`, selected patch emission, native `thread/status/changed`, and realtime transcript cursor redaction.
- `apps/web/src/timeline/threadViewGuard.test.ts` forbids browser-rendered lifecycle dependency on raw `timeline.item_delta`, `timeline.projection_patch`, and `timeline.snapshot_required`.
- `apps/web/src/timeline/reducer.lifecycle.test.ts` covers canonical `thread_view.patch`, stale patch guards, and `thread_view.refresh_required` as cursor-only.

## Target Shape

- App-server remains the only durable transcript/history source. Gateway SQLite may persist coordination state such as approvals, queued inputs, read state, notifications, pins, and compact cursor markers, but not transcript rows.
- `ThreadViewStore` is explicitly an in-memory selected-thread view cache:
  - one app-server loaded window,
  - one live overlay for not-yet-materialized active items,
  - pending approval/user-input summaries,
  - monotonic view revision/cursor state.
- App-server turn snapshots are authoritative for durable item order, terminal turn state, and completed turn timing. Gateway live deltas are a temporary overlay until app-server materializes the real turn/item snapshot or the client refetches.
- Browser reducers treat gateway rows as the canonical renderer contract. They replace/upsert rows by gateway row ids and revisions, not by app-server raw notification order or text heuristics except for strictly local, unconfirmed optimistic affordances.
- Cursor or replay uncertainty always converges by refetching `GET /v1/threads/{threadId}`. `thread_view.refresh_required` remains a refetch signal only.

## Non-Goals

- Do not implement the separate normal-submit steer-routing change here. Active submit behavior belongs in the steer plan.
- Do not redesign timeline visual presentation, work-row layout, collaboration rendering, file preview rendering, or mobile/native iOS UI.
- Do not remove approval, queued-input, automation, read-state, pin, or notification persistence; those are coordination state, not transcript history.
- Do not pursue the archived performance-overhaul compact DTO/detail-hydration scope unless a cleanup step exposes a small required DTO change.
- Do not add a gateway durable transcript cache for performance or reconnect recovery.

## Milestones

### 1. Lock The Ownership Boundary With Tests

Scope: `apps/gateway/src/thread_view.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/events_replay.rs`, `apps/gateway/src/events/tests.rs`, `apps/gateway/src/thread_view/tests.rs`, `apps/web/src/timeline/threadViewGuard.test.ts`, and `apps/web/src/timeline/reducer.lifecycle.test.ts`.

Work:

- Add or tighten tests that fail if transcript-like app-server notifications become durable renderer rows again:
  - item delta/upsert, turn upsert/completed, realtime transcript, and thread status notifications persist only compact cursor/operational metadata.
  - selected-thread replay after a cursor gap yields either validated `thread_view.patch` or `thread_view.refresh_required`, never raw row reconstruction.
- Add `ThreadViewStore` tests that state the ownership rules directly:
  - app-server snapshots/pages replace the loaded app-server window for their declared merge mode,
  - older-page prepend is the only path that extends loaded historical turns,
  - live overlay rows are removed or replaced when the app-server snapshot materializes the same turn/item,
  - terminal turn state comes from `ThreadTurnSnapshot`, not `item/completed`.
- Extend frontend guardrails so production rendering cannot import or reduce removed legacy timeline payload types or raw transcript event names, while allowing tests and generated schema files until the API cleanup milestone removes them.
- Document in test names that `thread_view.refresh_required` is cursor/refetch control flow, not a row source.

Exit criteria:

- Focused backend tests fail if a transcript-like app-server payload is persisted as replayable visible timeline data.
- Focused frontend tests fail if raw app-server item/turn events become visible timeline inputs.
- The test names and assertions clearly distinguish durable app-server history from gateway in-memory render state.

### 2. Split Loaded App-Server Window From Live Overlay

Scope: `apps/gateway/src/thread_view.rs`, `apps/gateway/src/thread_view_projection.rs`, `apps/gateway/src/thread_view_patch.rs`, and `apps/gateway/src/thread_view/tests.rs`.

Work:

- Refactor `ThreadView` fields and helper names so ownership is explicit:
  - rename `history_turns` to a loaded-window term such as `loaded_window_turns`,
  - keep `history_page` as paging metadata for that loaded window,
  - isolate live overlay items/turns from app-server loaded turns instead of treating all cached turns as one history list.
- Replace broad merge APIs with mode-specific operations:
  - replace selected app-server window,
  - prepend older app-server page,
  - refresh recent completed-turn head,
  - apply live item delta/upsert,
  - apply app-server turn status.
- Keep live overlay preservation only for bounded cases where app-server may lag active streaming text:
  - same scoped item id with newer live text,
  - pending user input until the app-server user item materializes,
  - active live rows for a turn not yet present in the loaded window.
- Remove or narrow text-based duplicate suppression so it cannot hide distinct durable app-server items. Text matching should remain only for pending local user input reconciliation when no app-server item id exists yet.
- Keep context-compaction pruning tied to app-server terminal turn snapshots and explicit terminal patches; do not use it as a general history repair mechanism.

Exit criteria:

- `ThreadView` code reads as `loaded app-server window + live overlay + pending request summaries`, not as a second durable transcript.
- Existing older-history tests still pass, including loaded older cursor preservation and reset-window behavior.
- New tests prove a selected-thread refetch can discard stale in-memory loaded-window turns and converge from app-server pages plus any still-active live overlay.

### 3. Align Event Ingest With Native App-Server Lifecycle

Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/events_replay.rs`, `apps/gateway/src/events_synthetic.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/api.rs`, and backend route/event tests.

Work:

- Rename internal cursor source labels away from replay-era `timeline.*` names where they are not browser contracts. Prefer labels that identify the app-server source method and the gateway action, such as cursor reasons under `thread_view.cursor`.
- Keep only these browser-visible render/control event kinds for selected thread rows:
  - `thread_view.patch`,
  - `thread_view.refresh_required`,
  - diagnostics such as `gateway.warning` and `gateway.error`.
- Continue using native app-server notifications as inputs:
  - `item/agentMessage/delta` and item upserts update the live overlay and emit bounded turn patches,
  - `turn/completed` and terminal turn upserts reconcile from app-server turn snapshots,
  - `thread/status/changed` emits lifecycle patches and clears stale active routing state,
  - `thread/compacted` triggers a native snapshot/window refresh.
- Change `thread/compacted` reconciliation to reuse the same selected-history path as `GET /v1/threads/{threadId}` where practical, instead of a separate `thread_read includeTurns:true` branch.
- Remove unused public/OpenAPI DTOs that describe old granular timeline payloads if they no longer have a production route or event contract:
  - `TimelineItemDeltaPayload`,
  - `TimelineTurnUpsertPayload`,
  - `TimelineThreadStatusPayload`.
- Keep `TimelineItemUpsertPayload` only if it remains the compact payload inside `ThreadTimelineSnapshotItem`; rename it later only if that improves clarity without churn.

Exit criteria:

- `rg "timeline\\.item_delta|timeline\\.item_upsert|timeline\\.turn_upsert|timeline\\.thread_status" apps/gateway/src apps/web/src` finds no production browser contract dependency; any remaining matches are tests for blocked regressions or intentional cursor-source assertions updated to the new names.
- OpenAPI and generated frontend types no longer expose unused granular timeline payload schemas if they were removed.
- Event replay tests still prove missed cursor or invalid patch replay produces `thread_view.refresh_required`.
- `cargo test events` and relevant route SSE tests pass.

### 4. Thin The Frontend Timeline Reducer Further

Scope: `apps/web/src/timeline/reducer.ts`, `apps/web/src/timeline/batch.ts`, `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/useReadonlyThreadTimeline.ts`, `apps/web/src/timeline/*.test.ts*`, `apps/web/src/App.tsx`, and `apps/web/src/api/client.ts`.

Work:

- Delete unreachable raw-event reducer helpers left over from pre-canonical rendering, including `withCanonicalSnapshotLiveState` and `applyPresentedCanonicalItem`, after confirming no production imports.
- Keep reducer entry points focused:
  - `applyTimelineSnapshot`,
  - `applyTimelineHistoryWindow`,
  - `applyLiveTimelineUpdate` for `thread_view.patch`, `thread_view.refresh_required`, and gateway diagnostics.
- Make partial patch behavior row-id and turn-id based only:
  - full snapshot replaces rows,
  - turn patch replaces/removes affected turn rows,
  - lifecycle patch updates active/pending metadata only.
- Audit optimistic user-message handling:
  - preserve it only as a per-tab, unconfirmed send affordance before gateway/app-server confirmation,
  - make sure confirmed shared visibility comes from gateway pending rows or app-server materialized user items,
  - do not use optimistic text matching as a durable transcript reconciliation rule.
- Keep `applyTimelineHistoryWindow` aligned with backend loaded-window semantics: older-page snapshots prepend app-server rows and do not assert a new durable history source.

Exit criteria:

- `rg "applyPresentedCanonicalItem|withCanonicalSnapshotLiveState" apps/web/src/timeline` finds no production code.
- Focused reducer tests cover stale patch rejection, lifecycle-only patches, older-history prepend, reset-window replacement, optimistic row removal, and raw event ignorance.
- `cd apps/web && npm test -- src/timeline/reducer.lifecycle.test.ts src/timeline/reducer.snapshot.test.ts src/timeline/batch.test.ts src/timeline/threadViewGuard.test.ts` passes.

### 5. Snapshot/Stream Recovery And Multi-Client Validation

Scope: `apps/gateway/src/events_replay.rs`, `apps/gateway/src/routes/mod.rs` SSE tests, `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/useReadonlyThreadTimeline.ts`, selected-thread app tests, and `$agent-browser` validation.

Work:

- Strengthen selected-thread stream tests:
  - connect after a canonical snapshot cursor and receive only newer validated patches,
  - replay over cursor-only transcript changes emits one `thread_view.refresh_required`,
  - invalid or old-shape `thread_view.patch` replay emits refresh-required instead of applying stale rows,
  - lagged broadcast receiver triggers refresh-required without advancing durable history.
- Add frontend tests for reconnect/refetch convergence:
  - live patch applies while selected,
  - refresh-required refetch replaces from `GET /v1/threads/{threadId}`,
  - stale queued patches cannot override the newer snapshot,
  - older-history request in flight does not corrupt a newer selected-thread snapshot.
- Add a same-user two-client test shape where one client misses live thread-view patches and later converges through snapshot/refetch without relying on another tab's React state.
- Use `$agent-browser` during implementation to validate:
  - active thread streaming row updates,
  - refresh/reconnect recovery,
  - older-history loading,
  - two browser contexts converging after one misses events,
  - no duplicate user/assistant rows after terminal turn reconciliation.

Exit criteria:

- Selected-thread correctness after missed events is proven by app-server-backed snapshot refetch, not by persisted transcript replay.
- Browser-visible rows remain stable across reconnect, older-history load, and two-client convergence.
- `$agent-browser` validation is recorded in the implementation notes when this plan is executed.

### 6. Documentation, Generated Artifacts, And Cleanup

Scope: `apps/gateway/src/api.rs`, `apps/web/src/api/generated/schema.ts`, `apps/web/src/api/client.ts`, `README.md` if public behavior wording changes, `AGENTS.md` only if contributor rules change, and this plan/index.

Work:

- Regenerate OpenAPI/frontend types if any public DTOs or event payload schemas change.
- Update comments in `thread_view.rs`, `events.rs`, and reducer tests to describe the final ownership model without implying gateway durable history.
- Update README only if route/event behavior or setup commands change.
- Keep `plans/index.md` status current when implementation starts and completes.
- During implementation, run an independent review pass per repo workflow before marking the plan complete.

Exit criteria:

- Generated API artifacts are current if schemas changed.
- Comments and docs distinguish:
  - app-server durable transcript/history,
  - gateway in-memory renderer contract,
  - gateway durable coordination state.
- No plan/index/doc status says complete until tests, generated artifacts, and browser validation are done.

## Verification

Backend:

- `cargo fmt`
- `cargo test events`
- `cargo test thread_view`
- Relevant route/SSE tests in `apps/gateway/src/routes/mod.rs`
- Full `cargo test` before completion

Frontend:

- `cd apps/web && npm test -- src/timeline/reducer.lifecycle.test.ts src/timeline/reducer.snapshot.test.ts src/timeline/batch.test.ts src/timeline/threadViewGuard.test.ts`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Regenerate API types after DTO changes with a running gateway: `cd apps/web && npm run generate:api`

Browser:

- Use `$agent-browser` against a local fullstack app for selected active thread streaming, refresh-required recovery, older-history loading, and same-user two-client convergence.

Static audits:

- `rg "codex.notification" apps/gateway/src apps/web/src`
- `rg "timeline\\.item_delta|timeline\\.item_upsert|timeline\\.turn_upsert|timeline\\.thread_status" apps/gateway/src apps/web/src`
- `rg "TimelineItemDeltaPayload|TimelineTurnUpsertPayload|TimelineThreadStatusPayload" apps/gateway/src apps/web/src`
- `rg "applyPresentedCanonicalItem|withCanonicalSnapshotLiveState" apps/web/src/timeline`

## Risks And Open Questions

- Some cursor metadata and tests still use `timeline.*` names as source-kind labels. Renaming them is useful for clarity, but implementations should avoid broad event taxonomy churn beyond selected-thread transcript events.
- Live overlay preservation protects users from losing active streaming text when app-server snapshots lag. Over-tightening it could cause visible truncation during active turns; tests should pin the intended active-only preservation cases.
- Pending approval/user-input persistence is coordination state. It must remain durable enough for reload/two-client UX, but it must not be rendered as transcript history unless app-server materializes an item.
- Removing old OpenAPI DTOs may require frontend generated schema changes and import cleanup outside `timeline/`. Keep that work in the same implementation chunk if the schemas are removed.
- `thread_view` is gateway-owned state for the currently loaded gateway process. After gateway restart, correctness must come from app-server snapshots and durable coordination state, not from rebuilding a lost in-memory overlay.
