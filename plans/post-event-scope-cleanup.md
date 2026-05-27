# Post Event Scope Cleanup Plan

## Status

Proposed.

## Context

The completed [Event scope and stream dedup plan](event-scope-and-stream-dedup.md) made `thread_view.patch` payload scope explicit and removed duplicate selected-thread delivery across the selected and global SSE streams. This plan picks up the follow-up audit milestones from that post-contract state.

The goal is to reduce the remaining large-thread cost without preserving ambiguous legacy paths. The browser should keep rendering gateway-owned canonical thread views, selected/global stream delivery should stay de-duplicated, and any state that must converge across tabs should remain gateway-owned.

Related active work:

- [Performance overhaul plan](performance-overhaul.md) is still `Active` and already covers broad startup, static serving, composer acceptance, and selected-thread latency. This plan should coordinate with it, but stays narrower: thread-view payload shape, reducer cost, event-to-cache routing, large-file decomposition, and diagnostics.

Relevant code seams:

- `apps/gateway/src/app_server_api.rs` defines public selected-thread DTOs such as `ThreadViewResponse`, `ThreadTimelineSnapshot`, `ThreadTimelineRow`, and `ThreadTimelineSnapshotItem`.
- `apps/gateway/src/thread_view.rs` owns the in-memory canonical thread view, row construction, full-snapshot/turn/lifecycle patch construction, and most projection tests.
- `apps/gateway/src/events.rs` owns browser-visible event normalization, SSE replay filtering, thread-view patch event creation, queue/read/notification event fanout, and event tests.
- `apps/gateway/src/routes/mod.rs` and `apps/gateway/src/routes/threads.rs` contain selected-thread, SSE, sidebar, and integration route coverage.
- `apps/web/src/timeline/reducer.ts`, `apps/web/src/timeline/batch.ts`, and `apps/web/src/timeline/useSelectedThreadTimeline.ts` apply snapshots, coalesce live events, and update timeline state.
- `apps/web/src/App.tsx` is still a 2,000-line shell that owns global SSE fanout, selected-thread stream fanout, sidebar cache mutation/invalidation, composer orchestration, subagent invalidation, automation routing, approvals, and route selection.
- `apps/web/src/threads/cache.ts` and `apps/web/src/threads/events.ts` own much of the sidebar/read/pin/notification projection logic, but cache routing is still driven from `App.tsx`.

## Current State

- The selected-thread contract now has explicit `ThreadViewPatchScope`, but `ThreadTimelineSnapshot` still serializes both `rows` and flat `items`. Rows also embed `ThreadTimelineSnapshotItem` values, so large snapshots and full-snapshot patches can duplicate renderable data.
- `ThreadTimelineSnapshotItem.payload` still carries raw-ish app-server item data through the public DTO even when the browser renderer needs only a compact normalized subset.
- `applyCanonicalRowsPatch` rebuilds normalized rows and indexes from broad arrays for every full snapshot and from the whole updated row list for each turn patch. That is safer after the scope cleanup, but still costly for large active threads.
- `useSelectedThreadTimeline` and `timeline/batch.ts` coalesce selected-thread events, but there is no deterministic budget test for many same-frame turn patches against a large synthetic timeline.
- `App.tsx` directly decides which event kinds mutate caches, invalidate queries, update selected-thread side state, and refetch sidebar lists. This makes it hard to audit whether a new gateway event will patch cache locally or trigger broad invalidation.
- `events.rs`, `thread_view.rs`, and `App.tsx` are large enough that follow-up lifecycle or performance work has a high chance of touching unrelated responsibilities.
- The existing `performance` module and `apps/gateway/scripts/profile-hot-paths.sh` provide backend route/RPC timing, but the frontend has no dev-only counters for SSE event rate, patch bytes, reducer time, cache invalidations, duplicate selected/global events, or browser long tasks.

## Non-Goals

- Do not redesign timeline visual presentation, composer UX, approvals UI, notification UI, or sidebar layout.
- Do not add WebSockets or a second browser transport.
- Do not make diagnostics part of correctness. They should catch regressions and guide profiling, not drive business logic.
- Do not keep old ambiguous DTOs or reducer paths merely for transition. This is a local monorepo cleanup and can hard-cut generated API types when tests and consumers are updated in the same change.
- Do not duplicate broad startup/static/composer milestones already tracked in `performance-overhaul.md`.

## Milestones

### 1. Snapshot Payload Diet

Scope: `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/thread_view.rs`, `apps/gateway/src/routes/mod.rs`, `apps/web/src/timeline/reducer.ts`, timeline renderers/tests, OpenAPI generation.

Work:

- Replace the hot-path selected-thread DTO contract with a render-oriented shape where `rows` are the browser timeline source and flat `timeline.items` is removed, gated behind debug-only data, or narrowed to only metadata that rows cannot carry.
- Split display DTOs from raw app-server payloads. Keep renderer-needed fields explicit for text, reasoning/work, command output, file changes, images, approvals, collaboration/subagent rows, and unknown fallback rows.
- For large command output, diffs, image metadata, and collaboration payloads, carry preview data in the initial row and define a full-detail fetch path only when the renderer needs it.
- Update `ThreadViewPatch::full_snapshot` and `ThreadViewPatch::turn` so scoped patches follow the same compact row contract and no longer include duplicated full `items` unless a specific consumer still proves it is required.
- Add serialized-size regression tests for:
  - a large selected-thread detail response,
  - a full-snapshot patch,
  - an active-turn patch with many prior historical rows,
  - a lifecycle patch.
- Regenerate OpenAPI and `apps/web/src/api/generated/schema.ts`.

Exit criteria:

- Browser rendering still consumes canonical snapshots, scoped `thread_view.patch`, and canonical text deltas only.
- Large snapshot and patch tests fail if duplicated renderable item payloads reappear in hot-path DTOs.
- Frontend tests prove current row renderers still work from the compact row contract, including unknown-item fallback behavior.
- Generated API types are updated in the same change.
- `$agent-browser` opens a large thread, loads older history, expands any deferred row details introduced by the milestone, and confirms scrolling/composer controls remain responsive on desktop and narrow/mobile viewports.

### 2. Timeline Reducer Budget And Incremental Indexing

Scope: `apps/web/src/timeline/reducer.ts`, `apps/web/src/timeline/state.ts`, `apps/web/src/timeline/batch.ts`, `apps/web/src/timeline/useSelectedThreadTimeline.ts`, focused reducer/batch tests.

Work:

- Add deterministic reducer budget tests with a synthetic large thread and many same-frame turn patches. Keep the test stable by asserting operation counts, elapsed fake clock thresholds, or explicit instrumentation counters rather than wall-clock-only timing.
- Coalesce same-frame patches per thread/turn before reducer application when multiple patches would replace the same row in one animation frame.
- Replace whole-row-array filtering and whole-index rebuilds in turn-patch paths with incremental row-key and canonical-item indexes maintained in `TimelineState`.
- Keep full-snapshot application simple and authoritative; optimize turn patches first because they are high-frequency during streaming.
- Preserve optimistic user-row reconciliation and hidden-item indexing behavior while making the mutation path cheaper.

Exit criteria:

- Focused reducer tests fail if a turn-scoped patch rebuilds all large-thread rows or loses optimistic user rows.
- Batch tests prove same-frame patch coalescing keeps only the latest patch for the same affected row/turn while preserving lifecycle updates and event cursor advancement.
- Existing timeline snapshot, lifecycle, batch, and app-level streaming tests pass.
- Browser validation shows a large active thread can receive a running response while scrolling remains usable and no obvious blank/overlap rows appear.

### 3. Typed Event-To-Cache Routing

Scope: `apps/web/src/App.tsx`, `apps/web/src/events/*`, `apps/web/src/threads/cache.ts`, `apps/web/src/threads/events.ts`, app-level SSE/cache tests.

Work:

- Extract global and selected-thread event routing from `App.tsx` into typed domain helpers, for example `events/liveRouting.ts`, `threads/liveCacheRouting.ts`, and `timeline/selectedThreadEvents.ts`.
- Define one routing table or typed decision helper per browser-visible event family:
  - timeline/thread-view events,
  - thread metadata/upsert/pin/read/notifications,
  - queue events,
  - approval events,
  - automation events,
  - skills/MCP/account events,
  - gateway diagnostics.
- For each event kind, document in code whether it patches cache, invalidates a narrow query, invalidates broad sidebar state, updates selected-thread local UI state, or is intentionally ignored.
- Replace broad sidebar invalidations from selected-thread patches with cache patching or a documented narrow refetch only when metadata is missing.
- Keep the protocol-level selected/global stream exclusion from `event-scope-and-stream-dedup.md`; do not reintroduce client-side duplicate selected-thread processing as the primary defense.

Exit criteria:

- `App.tsx` no longer contains the event-kind routing matrix; it coordinates hooks and passes callbacks.
- App-level tests fail if selected-thread patches refetch sidebar/project/chat lists except for explicitly missing metadata cases.
- Tests cover non-selected thread updates through the global stream, selected-thread operational updates through the selected stream, and thread switching without duplicate selected/global handling.
- Same-user two-tab test shape proves cache/read/sidebar state converges from gateway-owned events without reload.

### 4. Large-File Responsibility Split

Scope: `apps/web/src/App.tsx`, `apps/gateway/src/events.rs`, `apps/gateway/src/thread_view.rs`, associated tests.

Work:

- Split `App.tsx` into feature hooks/modules for:
  - route and selected-thread state,
  - global stream fanout,
  - selected-thread shell reactions,
  - sidebar live cache updates,
  - optimistic composer/draft-thread orchestration,
  - subagent discovery invalidation.
- Split `events.rs` into smaller backend modules for:
  - SSE query/replay/filtering,
  - app-server notification normalization,
  - thread-view event emission,
  - queue/read/notification event helpers,
  - diagnostics and synthetic events.
- Split `thread_view.rs` into smaller modules for:
  - store/session ownership,
  - row construction,
  - patch construction and validation,
  - pending overlay/reconciliation helpers,
  - projection tests grouped by behavior.
- Keep public DTO definitions in existing public API modules unless moving them clearly reduces coupling and generated OpenAPI output stays stable.

Exit criteria:

- File-size and ownership guardrails in `AGENTS.md` are easier to satisfy: new behavior has a clear domain home and no single extracted module becomes a replacement large file.
- Existing focused backend/frontend tests pass with no behavior changes.
- Review can identify event routing, patch construction, and selected-thread shell behavior without reading all of `App.tsx`, `events.rs`, or `thread_view.rs`.

### 5. Dev-Only Streaming And Render Diagnostics

Scope: frontend event stream/timeline modules, `apps/gateway/src/performance.rs`, development docs, optional debug UI or console diagnostics.

Work:

- Add dev-only counters for:
  - SSE events received per stream,
  - selected/global duplicate drops,
  - patch byte sizes by kind/scope,
  - reducer application count and duration,
  - cache invalidation count by query key family,
  - selected-thread refresh-required count,
  - browser long tasks when `PerformanceObserver` supports them.
- Keep labels free of prompt text, raw payloads, local file contents, auth data, or project secrets.
- Make counters easy to inspect during `$agent-browser` validation through console output, a debug endpoint, or a development-only panel.
- Add tests for pure counter helpers and no-op behavior in production builds where practical.

Exit criteria:

- Diagnostics can reveal whether a selected-thread send is still doing duplicate work, producing oversized patches, spending too long in the reducer, or invalidating broad caches.
- Production behavior and generated API contracts are unchanged unless a backend diagnostic endpoint is explicitly added and documented.
- `$agent-browser` validation can capture or query the counters while sending a short running prompt in a large thread.

## Verification

Run milestone-specific focused checks first, then broader checks before marking the plan complete:

- `cargo fmt`
- `cargo test -p kodex-gateway thread_view`
- `cargo test -p kodex-gateway sse`
- `cargo test -p kodex-gateway`
- `cd apps/web && npm test -- --run src/timeline/reducer.snapshot.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/batch.test.ts src/events/stream.test.ts src/threads/events.test.ts`
- `cd apps/web && npm test -- --run src/App.mvp.timeline.test.tsx src/App.mvp.composer-input.test.tsx src/App.subagents.test.tsx src/App.automations.test.tsx`
- `cd apps/web && npm run build`

When public DTOs or routes change:

- run the gateway,
- inspect `GET /openapi.json`,
- `cd apps/web && npm run generate:api`,
- commit `apps/web/src/api/generated/schema.ts` with the implementation.

Browser validation:

- Use `$agent-browser` against the local app.
- Validate desktop fine pointer, narrow fine pointer, and narrow/mobile touch-shaped viewport behavior.
- Use a large real or synthetic thread with command output, file changes, image/collaboration rows if available, older-history loading, and a short running prompt.
- Confirm no blank rows, overlapping text, broken composer controls, selected/global duplicate stream handling, or console/runtime errors.

## Risks And Open Questions

- `performance-overhaul.md` already covers selected-thread snapshot payloads and render work. Before implementation starts, decide whether to mark overlapping milestones complete there, supersede those sections with this narrower plan, or explicitly implement this plan as the detailed child plan.
- Removing flat `timeline.items` may break tests or renderers that still use item-level helpers. The implementation should hard-cut browser code to rows rather than keeping duplicate DTOs as compatibility ballast.
- Deferred detail endpoints for large rows may need app-server support that is not currently stable. If upstream does not expose safe item-detail reads, milestone 1 should prefer compact previews from existing loaded data instead of inventing an unsupported transcript source.
- Incremental reducer indexing can introduce subtle ordering and hidden-item bugs. Keep full snapshots authoritative and add tests for file-change rows, work rows, optimistic user rows, and unknown fallback rows before optimizing.
- Diagnostics can become noisy or privacy-sensitive if labels include raw payload data. Treat privacy-safe labels as an exit criterion, not a cleanup note.

