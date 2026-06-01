# Thread View Native Lifecycle Simplification Plan

## Status

Complete.

## Implementation Notes

Implemented in one review-loop pass after the plan was created:

- `ThreadViewPatch` now uses complete scoped row replacement: full snapshots carry full rows, turn patches carry complete rows plus `affectedTurnIds`, and lifecycle patches carry no render rows. The old `upsertRows` and `removeRowIds` public fields were removed from gateway, web, and native client surfaces.
- Gateway thread-view reconciliation was narrowed to app-server-native identity and explicitly bounded live-overlay cleanup. Broad transcript-style text matching was removed; exact text fallback remains only for gateway-accepted pending user input before app-server materializes it.
- Event cursor diagnostics were renamed from legacy `timeline.*` transcript labels to `thread_view.*` ownership labels while preserving legacy migration handling where needed for stored completed-turn counters.
- Web timeline state now applies canonical snapshots and complete affected-turn patches; reducer-side file-change dedupe, arbitrary item-id replacement, and optimistic text reconciliation paths were removed.
- Web timeline hidden diagnostic items now follow the same canonical replacement semantics as visible rows: full snapshots replace them, and turn patches replace only affected-turn diagnostics.
- The browser timeline virtualization path now renders a bounded initial row set before bottom alignment runs, avoiding a stuck empty selected-thread view when the custom scroll parent has not measured yet.
- Attach/resume and runtime routing now revalidate against app-server loaded/readback state instead of treating stale gateway runtime/thread-view state as final lifecycle truth.
- iOS live update coalescing and generated API surfaces were updated to the same complete turn replacement contract.

Verification completed:

- `cargo fmt`
- `cargo test -p kodex-gateway thread_view`
- `cargo test -p kodex-gateway events`
- focused gateway route tests for attach/resume, input routing/readback, compaction, SSE replay, and missing-thread resume retry
- `cargo test`
- `cd apps/web && npm test -- src/timeline/reducer.snapshot.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/batch.test.ts src/timeline/threadViewGuard.test.ts`
- `cd apps/web && npx tsc --noEmit --pretty false`
- `cd apps/web && npm test -- src/App.mvp.timeline.test.tsx src/App.mvp.composer-input.test.tsx src/App.subagents.test.tsx`
- `cd apps/web && npm test -- src/App.test.tsx src/timeline/TimelineView.render.test.tsx`
- `cd apps/web && npm run build`
- `cd apps/ios && swift test`
- `$agent-browser` smoke against `http://127.0.0.1:5173/threads/019e8532-c009-7cf3-b8e7-14cfd569ee86`: fresh session loaded canonical selected-thread detail, attach, selected/global SSE streams, rendered 30 virtualized timeline rows from the canonical snapshot, and had no console errors beyond Vite/React dev info.

## Context

Kodex has already moved most selected-thread rendering to a gateway-owned `ThreadViewResponse` plus `thread_view.patch` contract. That direction is correct: app-server owns durable thread, turn, item, and message history; the gateway owns a canonical multi-client projection; browsers and native clients render that projection.

The remaining risk is that the gateway and web reducer still carry compatibility-era lifecycle and transcript logic that can become a second transcript source:

- `apps/gateway/src/thread_view.rs` preserves or prunes live rows across snapshots using text matching, live-over-snapshot comparisons, missing-context-compaction heuristics, and item-delta accumulation.
- `apps/gateway/src/events.rs` no longer replays raw transcript rows, but it still persists cursor rows whose `sourceKind` values are legacy transcript labels such as `timeline.item_delta`, `timeline.item_upsert`, `timeline.turn_upsert`, and `timeline.thread_status`.
- `apps/gateway/src/thread_view_patch.rs` exposes scoped patches, but turn patches still use `upsertRows` and `removeRowIds`, so the frontend has to maintain partial-row replacement and omission behavior.
- `apps/web/src/timeline/reducer.ts` renders canonical rows, but still preserves optimistic user rows by text, dedupes duplicate file-change rows, supports partial upsert/remove turn patches, and keeps item/turn merge helpers that are broader than a strict row renderer needs.
- `apps/gateway/src/routes/threads.rs` returns `ThreadViewResponse` for selected-thread detail and older-history pages, but `POST /v1/threads/{threadId}/resume` still returns metadata-only `ThreadCommandResponse`.
- `apps/gateway/src/turn_lifecycle.rs` and `apps/gateway/src/queue.rs` still use durable `thread_runtime_state.active_turn_id` in routing decisions. A separate proposed plan, [TUI-aligned active-turn steer](tui-aligned-active-turn-steer.md), owns the steer-first `/input` behavior; this plan should not duplicate that implementation scope.

The target is not to remove the gateway projection. The target is to keep it clearly bounded: a canonical in-memory projection of app-server-native snapshots/events plus gateway-owned coordination overlays, never a durable or independently inferred transcript.

## Contract Sources

- `AGENTS.md` requires app-server schemas and the upstream app-server README as the wire contract, with upstream TUI as a real-client sequencing reference.
- The checked-in schema is `apps/gateway/app-server-schema/0.135.0/VERSION` (`codex-cli 0.135.0`).
- The checked-in 0.135.0 schema documents:
  - `thread/resume` with `excludeTurns`,
  - `thread/read` with `includeTurns`,
  - paged `thread/turns/list` with `itemsView`,
  - native notifications including `thread/status/changed`, `thread/settings/updated`, `turn/started`, `turn/completed`, `item/started`, `item/completed`, and `item/agentMessage/delta`.
- The upstream app-server README describes `thread/resume` as the resume primitive, `thread/turns/list` as paged stored history, `turn/steer` as the active-turn input primitive, and `thread/*`, `turn/*`, and `item/*` notifications as the event stream.

## Target Shape

- App-server remains the only durable transcript/history source.
- Gateway `ThreadViewStore` remains the canonical multi-client projection for selected thread views, loaded history windows, active live overlays, pending gateway-accepted user input, and pending approval/user-input request summaries.
- Gateway live overlays are constrained to app-server-native active/live signals:
  - active or in-progress turns from `thread/resume`, `thread/read`, `thread/turns/list`, `turn/started`, `turn/upsert`, `turn/completed`, and `thread/status/changed`,
  - item deltas/upserts only while their turn is live,
  - pending local input only after gateway acceptance and only until app-server materializes the item or the request fails.
- Browser timeline state is a thin row store:
  - apply canonical snapshots,
  - apply canonical scoped `thread_view.patch` rows,
  - ignore stale revisions,
  - treat `thread_view.refresh_required` as a refetch signal only,
  - keep only per-tab UI state such as scroll, expansion, focus, drafts, and unsent/failed upload affordances.
- Gateway operational state remains durable where it is not transcript history: approvals, queued inputs, read state, pins, notifications, automations, metadata overlays, skill mention metadata, and queue-drain coordination.

## Non-Goals

- Do not remove the gateway `ThreadViewStore` canonical projection.
- Do not add durable gateway transcript rows, item history tables, or raw app-server replay as browser history.
- Do not implement the steer-first `/input` behavior here; coordinate with [TUI-aligned active-turn steer](tui-aligned-active-turn-steer.md).
- Do not redesign timeline visual presentation.
- Do not expose Kodex beyond localhost/trusted-VPN assumptions.

## Milestones

### 1. Lock Native Lifecycle Boundaries

Scope: `apps/gateway/src/thread_view.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/events_replay.rs`, `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/thread_view/tests.rs`, `apps/gateway/src/events/tests.rs`, `apps/web/src/timeline/threadViewGuard.test.ts`, and timeline reducer tests.

Work:

- Add or tighten tests that describe what the gateway is allowed to infer:
  - active turn state comes from app-server snapshot/native lifecycle state or an accepted gateway pending input, not from arbitrary historical item presence;
  - live item deltas after a terminal turn status are ignored until a later app-server snapshot says otherwise;
  - completed snapshots replace live overlay rows by app-server item identity;
  - duplicate live rows that are absent from completed app-server history are pruned only by narrowly documented live-overlay rules, not broad transcript text matching;
  - pending approval and tool-user-input summaries remain coordination state, not conversation rows unless app-server materializes items.
- Add static guardrails for forbidden production render dependencies:
  - no web timeline reducer path for `timeline.item_delta`, `timeline.item_upsert`, `timeline.turn_upsert`, `timeline.thread_status`, or `codex.notification`;
  - no normal `/v1/events` replay path that returns transcript cursor rows as visible history;
  - no browser-visible docs or tests describing `thread_view.refresh_required` as a row source.
- Update test names to use `thread_view` and native lifecycle language rather than legacy `timeline.*` transcript event names.

Exit criteria:

- Focused backend tests fail if gateway replay, routes, or thread view can reconstruct visible history from persisted transcript-like events.
- Focused frontend tests fail if raw app-server lifecycle events produce visible timeline rows.
- The new tests are in place before simplifying implementation code.

### 2. Constrain Gateway Thread View Overlay Semantics

Scope: `apps/gateway/src/thread_view.rs`, `apps/gateway/src/thread_view_projection.rs`, `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/routes/threads.rs`, and `apps/gateway/src/thread_view/tests.rs`.

Work:

- Separate `ThreadView` state conceptually, and in code if it reduces risk, into:
  - app-server loaded history window (`history_turns`, `history_page`),
  - live overlay rows for currently active/in-progress turns,
  - gateway pending user input overlays,
  - pending request summaries.
- Replace broad text-based duplicate handling with explicit reconciliation rules:
  - app-server item id and turn id win;
  - pending gateway user rows reconcile by a gateway-created pending id, app-server-returned turn id, and a narrowly scoped fallback for the exact pending user input text only while the row is still unmaterialized;
  - assistant/agent live rows reconcile by app-server item id, not by arbitrary matching text.
- Keep stale active snapshot protection, but tie it to active turn identity and revision, not general text length comparisons.
- Make context-compaction pruning depend on app-server-native turn completion and item presence rules. Keep the current regression coverage for missing live compaction markers, but document the condition as live-overlay cleanup rather than transcript repair.
- Keep older-history windows and live tail merge behavior from `plans/paged-selected-thread-timeline.md`, but make the invariant explicit: loading older history cannot create or delete live tail rows except through gateway live overlay rules.

Exit criteria:

- `ThreadViewStore` tests prove identical visible rows after:
  - snapshot-only completed history,
  - live deltas followed by app-server materialization,
  - stale active snapshot followed by newer live overlay,
  - older-history prepend while a live turn is active.
- `rg "text_key_for_snapshot_item|consume_text_match|should_preserve_live_item_over_snapshot" apps/gateway/src/thread_view.rs` either finds no production code or finds only a narrowly documented pending/live-overlay helper covered by tests.
- No new SQLite transcript storage is introduced.

### 3. Make Event Cursor Taxonomy Match Thread View Ownership

Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/events_replay.rs`, `apps/gateway/src/events_synthetic.rs`, `apps/gateway/src/routes/events.rs`, `apps/gateway/src/routes/mod.rs`, `apps/web/src/events/stream.ts`, and `apps/web/src/threads/events.ts`.

Work:

- Rename internal cursor `sourceKind` values away from transcript-row names where practical:
  - use names such as `thread_view.item_delta_observed`, `thread_view.item_upsert_observed`, `thread_view.turn_changed`, `thread_view.status_changed`, and `thread_view.turn_completed`;
  - preserve app-server `sourceMethod` for diagnostics.
- Keep `THREAD_VIEW_CURSOR_KIND` compact and diagnostic-only. It may advance cursors and trigger `thread_view.refresh_required`, but it must not carry item text, raw item payloads, or renderable rows.
- Continue using named operational events for metadata, read state, queue rows, approvals, settings, account, MCP, skills, notifications, automations, pins, subagents, and thread upserts.
- Audit `is_normal_live_event`, `is_operational_replay_event`, and `selected_thread_sse_replay_events` so selected streams can replay valid `thread_view.patch` events and operational events, while cursor gaps produce `thread_view.refresh_required`.
- Update tests that currently assert `sourceKind: "timeline.item_delta"` or similar legacy labels to assert the new diagnostic labels and absence of transcript payload.

Exit criteria:

- `rg "timeline\\.item_delta|timeline\\.item_upsert|timeline\\.turn_upsert|timeline\\.thread_status" apps/gateway/src apps/web/src --glob '!api/generated/schema.ts'` finds no production dependency except deliberately allowed migration comments or debug compatibility tests.
- Selected-thread SSE replay after a cursor gap emits `thread_view.refresh_required`, not stale transcript rows.
- Normal `/v1/events` replay remains operational-only.

### 4. Tighten `thread_view.patch` To Complete Scoped Row Replacement

Scope: `apps/gateway/src/thread_view_patch.rs`, `apps/gateway/src/thread_view_projection.rs`, `apps/gateway/src/thread_view.rs`, `apps/gateway/src/api.rs`, generated OpenAPI, `apps/web/src/api/generated/schema.ts`, `apps/web/src/timeline/batch.ts`, and reducer tests.

Work:

- Change the public patch contract so every render-bearing patch carries complete canonical rows for its scope:
  - `full_snapshot`: rows are the full loaded selected-thread view;
  - `turn`: rows are the complete canonical row set for the affected turn or turns;
  - `lifecycle`: no rows.
- Remove or deprecate public `upsertRows` and `removeRowIds` after the frontend has migrated. If a transition is required, keep it short and guarded by tests that fail when both old and new contracts are accepted indefinitely.
- Add an explicit affected scope field if needed, for example `affectedTurnIds`, so the browser can replace all rows for those turns without inferring omission semantics from row ids or item ids.
- Keep patch payload-size tests from `apps/gateway/src/thread_view/tests.rs`; turn patches should scale with affected turns, not historical rows.
- Regenerate OpenAPI and frontend generated types in the same implementation chunk.

Exit criteria:

- `ThreadViewPatch::validate_scope` rejects ambiguous row/upsert/remove mixtures.
- Backend tests prove turn patches include the complete affected-turn row graph, including work rows and collapsed file-change rows.
- Frontend batch coalescing drops superseded patches by `threadId + affectedTurnIds + viewRevision` instead of row-id heuristics.
- `rg "upsertRows|removeRowIds" apps/web/src apps/gateway/src --glob '!apps/web/src/api/generated/schema.ts'` finds no production dependency after the hard cut.

### 5. Reduce The Web Timeline Reducer To A Thin Row Store

Scope: `apps/web/src/timeline/reducer.ts`, `apps/web/src/timeline/state.ts`, `apps/web/src/timeline/batch.ts`, `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/useReadonlyThreadTimeline.ts`, `apps/web/src/timeline/testBuilders.ts`, and timeline tests.

Work:

- Keep reducer entry points small:
  - `applyTimelineSnapshot`,
  - `applyThreadViewPatch`,
  - `applyTimelineHistoryWindow`,
  - `applyDebugEvent`,
  - per-tab optimistic/failed upload helpers only where the gateway has not accepted the input.
- Delete production file-change row dedupe from the reducer once gateway row generation is strict. Duplicate file-change rows should fail backend row tests, not be corrected in React.
- Delete row replacement by canonical item id, server item id, and optimistic text matching for confirmed gateway rows. Row identity and replacement should come from canonical row ids plus affected patch scope.
- Keep optimistic user messages only as a pre-gateway-acceptance local affordance:
  - remove immediately on queued response or failed submit,
  - remove or replace when gateway accepted pending row appears,
  - do not use optimistic text matching as shared transcript truth.
- Keep debug events isolated from visible row ordering.
- Simplify tests to assert generated canonical rows and scoped patch replacement rather than item-shaped compatibility behavior.

Exit criteria:

- `apps/web/src/timeline/reducer.ts` no longer contains correctness paths for duplicate file-change suppression, arbitrary text-based user-row reconciliation, or raw item/turn lifecycle events.
- `apps/web/src/timeline/threadViewGuard.test.ts` fails if raw app-server lifecycle events become visible render inputs.
- Focused tests pass:
  - `cd apps/web && npm test -- src/timeline/reducer.snapshot.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/batch.test.ts src/timeline/threadViewGuard.test.ts`

### 6. Unify Selected Detail, Attach, And Resume Around The Canonical View

Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/app_server_api.rs`, `apps/web/src/api/client.ts`, selected-thread hooks, app-level timeline tests, and OpenAPI.

Work:

- Keep `GET /v1/threads/{threadId}` as the canonical selected-thread detail endpoint.
- Decide whether `POST /v1/threads/{threadId}/resume` should:
  - return `ThreadViewResponse` after resume plus bounded `thread/turns/list`, or
  - remain a metadata-only attach primitive that no renderer path consumes directly.
- Remove any frontend behavior that treats resume command responses as timeline data. Rendering must converge through `GET /v1/threads/{threadId}` snapshots and selected-thread `thread_view.patch`.
- Ensure `attach_thread` and `thread_is_already_attached` do not use stale gateway-only state to skip app-server-native loaded/resume checks when the selected-thread snapshot still needs recovery.
- Preserve materializing-thread retry behavior in `useSelectedThreadTimeline.ts`.

Exit criteria:

- `GET /v1/threads/{id}` and older-page routes are the only normal selected-thread render snapshot sources.
- Frontend tests prove selecting a resumed idle or active thread renders from canonical snapshot plus patches, not command response `rawPayload` or `turns`.
- OpenAPI/frontend generated types are updated if resume response shape changes.

### 7. Narrow Durable Runtime State To Queue Coordination

Scope: `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/queue.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/store.rs`, and focused route/queue tests.

Work:

- Coordinate with [TUI-aligned active-turn steer](tui-aligned-active-turn-steer.md). If that plan lands first, audit this milestone against its final helpers rather than redoing the routing work.
- Treat `thread_runtime_state` as queue-drain coordination and local in-flight command coordination only:
  - `draining`, `starting`, and `syncing` can block queue drains or second starts;
  - durable `active_turn_id` must not be a transcript or active-turn source of truth when app-server or `ThreadViewStore` disagrees;
  - app-server native status/readback and `ThreadViewStore` active state win for shared lifecycle decisions.
- Keep queue rows durable because they are coordination state, not transcript history.
- Add same-user two-client tests where a stale durable runtime active id cannot cause duplicate starts, stale queues, or wrong visible lifecycle state.

Exit criteria:

- `rg "get_thread_runtime_state\\(|active_turn_id" apps/gateway/src/routes apps/gateway/src/queue.rs apps/gateway/src/turn_lifecycle.rs` shows durable runtime state is not trusted as final active-turn truth.
- Queue drain still survives gateway restart and starts only when app-server/thread view says the thread is idle.
- Same-user two-client lifecycle tests pass.

### 8. Verification, Browser Validation, And Review

Scope: full implementation verification after the milestones above.

Work:

- Run backend checks:
  - `cargo fmt`
  - `cargo test -p kodex-gateway thread_view`
  - `cargo test -p kodex-gateway events`
  - focused route/queue tests touched by runtime-state changes
  - full `cargo test` before marking complete.
- Run frontend checks:
  - `cd apps/web && npm test -- src/timeline/reducer.snapshot.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/batch.test.ts src/timeline/threadViewGuard.test.ts`
  - `cd apps/web && npm test -- src/App.mvp.timeline.test.tsx src/App.mvp.composer-input.test.tsx src/App.subagents.test.tsx`
  - `cd apps/web && npm run build`
- Regenerate frontend API types after public DTO changes:
  - run a gateway,
  - inspect `GET /openapi.json`,
  - `cd apps/web && npm run generate:api`.
- Use `$agent-browser` against a local full-stack app for:
  - existing idle thread snapshot open,
  - active streaming thread switch-away/switch-back,
  - older-history load while live tail is active,
  - `thread_view.refresh_required` recovery,
  - pending approval/user-input resume,
  - two browser contexts where one misses patches and later converges through snapshot/SSE,
  - desktop fine pointer, narrow fine pointer, and narrow/mobile touch-shaped viewport checks.
- Run an independent review pass before marking implementation complete.

Exit criteria:

- Automated checks pass or unrelated flakes are isolated with focused passing reruns.
- Browser validation shows no duplicate user/assistant rows, no raw transcript replay dependency, no lost live tail after older-history loading, no stale Stop/Send state after snapshot recovery, and no console/runtime errors.
- `plans/index.md`, this plan status, README, and `AGENTS.md` are updated only if implementation changes behavior, commands, or contributor workflow.

## Risks And Open Questions

- Some active live item deltas may arrive before app-server materializes item ids in full history. The gateway still needs an in-memory live overlay; the simplification should constrain that overlay, not delete it.
- Pending user-input reconciliation may need a durable client request id to avoid exact-text matching entirely. If app-server does not echo such an id, keep the text fallback only for gateway-created pending user rows and document it as a pending-overlay rule.
- Removing `upsertRows`/`removeRowIds` changes public OpenAPI and native iOS generated clients. Coordinate generated TypeScript and Swift API updates if the implementation touches native clients.
- Runtime-state cleanup overlaps with the proposed active-turn steer plan. Avoid changing `/input` product behavior here unless that plan is also active and explicitly in scope.
- `thread/turns/items/list` exists in schema but upstream README says it is reserved/unsupported. Do not build detail hydration on it unless upstream support changes and the checked-in schema/README are updated.

## Plan-Time Verification

- Read root `AGENTS.md` and `plans/index.md`.
- Inspected requested gateway files:
  - `apps/gateway/src/thread_view.rs`
  - `apps/gateway/src/thread_view_patch.rs`
  - `apps/gateway/src/thread_view_projection.rs`
  - `apps/gateway/src/app_server_api.rs`
  - `apps/gateway/src/events.rs`
  - `apps/gateway/src/events_replay.rs`
  - `apps/gateway/src/events_synthetic.rs`
  - `apps/gateway/src/routes/threads.rs`
  - `apps/gateway/src/routes/turns.rs`
  - `apps/gateway/src/queue.rs`
  - `apps/gateway/src/turn_lifecycle.rs`
- Inspected requested frontend files:
  - `apps/web/src/timeline/reducer.ts`
  - `apps/web/src/timeline/useSelectedThreadTimeline.ts`
  - `apps/web/src/timeline/useReadonlyThreadTimeline.ts`
  - `apps/web/src/timeline/batch.ts`
  - `apps/web/src/events/stream.ts`
- Inspected requested tests:
  - `apps/gateway/src/thread_view/tests.rs`
  - `apps/gateway/src/events/tests.rs`
  - relevant `apps/gateway/src/routes/mod.rs` route/SSE tests
  - `apps/web/src/timeline/reducer.snapshot.test.ts`
  - `apps/web/src/timeline/reducer.lifecycle.test.ts`
  - `apps/web/src/timeline/batch.test.ts`
  - `apps/web/src/timeline/threadViewGuard.test.ts`
  - relevant app-level timeline tests.
- Inspected related plans:
  - [Thread client surface simplification](thread-client-surface-simplification.md)
  - [Thread session view cleanup](thread-session-view-cleanup.md)
  - [Timeline replay removal](timeline-replay-removal.md)
  - [TUI-aligned thread timeline simplification](tui-aligned-thread-timeline-simplification.md)
  - [Performance overhaul](performance-overhaul.md)
  - [Canonical timeline rows rewrite](canonical-timeline-rows-rewrite.md)
  - [Paged selected thread timeline](paged-selected-thread-timeline.md)
  - [Post event scope cleanup](post-event-scope-cleanup.md)
  - [TUI-aligned active-turn steer](tui-aligned-active-turn-steer.md)
- Verified contract sources:
  - `apps/gateway/app-server-schema/0.135.0/VERSION`
  - `apps/gateway/app-server-schema/0.135.0/json`
  - upstream app-server README at `https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md`.

No grilling was needed: the repository and existing plans already establish the intended product boundary.
