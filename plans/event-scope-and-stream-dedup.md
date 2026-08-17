# Event Scope And Stream Dedup Plan

## Status

Complete.

## Context

Recent mobile/iOS lag on very large threads came from two related failure modes:

- `thread_view.patch` was a broad event shape whose payload could be lifecycle-only, turn-scoped, or full-window depending on the emitter.
- The web app can subscribe to both the global `/v1/events` stream and the selected-thread `/v1/events?threadId=...` stream, allowing selected-thread live work to be parsed and routed twice.

The immediate fixes narrowed several hot paths, but this plan hardens the underlying contract. The implementation should remove ambiguous or worse paths as part of the change instead of preserving them for compatibility inside the local monorepo.

Relevant code seams:

- `apps/gateway/src/thread_view.rs` owns `ThreadTimelineSnapshot`, `ThreadViewPatch`, `turn_patch`, `to_patch`, `lifecycle_patch`, and thread-view mutation helpers.
- `apps/gateway/src/events.rs` converts app-server notifications into browser-visible events through helpers such as `thread_view_patch_event`, `thread_view_patch_payload_event`, and `thread_view_refresh_required_event`.
- `apps/gateway/src/routes/mod.rs` contains SSE route tests around selected-thread replay, live selected-thread patches, and refresh-required recovery.
- `apps/web/src/events/stream.ts` constructs EventSource URLs and registers named event listeners.
- `apps/web/src/App.tsx` owns the global event stream fanout, sidebar invalidation, subagent invalidation, selected-thread state updates, and selected stream orchestration.
- `apps/web/src/timeline/reducer.ts` applies snapshots, `thread_view.patch`, and `thread_view.refresh_required`.
- `apps/web/src/threads/events.ts` derives sidebar/read/runtime state from `thread_view.patch`.

## Current State

- `ThreadViewPatch` uses optional fields such as `rows`, `upsertRows`, `turns`, and `items` to imply patch scope. `turn_patch` currently sets `rows: None` and `upsertRows`, while `to_patch` sets full `rows`, but the event kind is the same.
- `thread_view_patch_payload_event` accepts any `ThreadViewPatch`, so call sites can accidentally emit a full-window patch from a high-frequency lifecycle or delta path.
- `thread_view_patch_event` still builds a full patch through `thread_view::patch_for_thread` and is callable from event code.
- Selected-thread SSE replay intentionally allows selected `thread_view.patch` replay after a cursor, while live global SSE also considers `thread_view.patch` a normal live event.
- `createEventStreamClient` only supports `cursor` and `threadId` query parameters, so the frontend has no protocol-level way to say "give me global events except the selected thread."
- `App.tsx` fans every global event through many domain handlers. Some handlers are now narrow, but the shape still makes it easy for selected-thread live patches to trigger duplicated work.

## Non-Goals

- Do not redesign timeline rendering, row presentation, composer layout, notifications UI, or approval UI.
- Do not solve snapshot payload bloat or timeline reducer indexing in this plan; those are next-step work after the event contract is hardened.
- Do not add WebSockets or a new transport.
- Do not preserve legacy ambiguous patch emission helpers merely to ease transition. This is a hard local cleanup.

## Milestones

### 1. Make Thread-View Event Scope Explicit

Scope: `apps/gateway/src/thread_view.rs`, `apps/gateway/src/events.rs`, backend SSE/event tests, generated OpenAPI only if public DTO names or schema fields change.

Work:

- Replace the implicit `ThreadViewPatch` scope contract with an explicit tagged scope, for example:
  - `scope: "full_snapshot"`
  - `scope: "turn"`
  - `scope: "lifecycle"`
- Keep the browser-visible event kind as `thread_view.patch` if that avoids unnecessary client churn, but require every payload to carry the explicit scope.
- Make invalid field combinations unrepresentable or rejected by constructors:
  - full snapshot patches may carry `rows`
  - turn patches may carry `upsertRows`, `turns`, and `items`, but must not carry full `rows`
  - lifecycle patches may carry active/live/pending state only, with no row/item payload
- Replace generic constructors with named APIs such as:
  - `ThreadViewPatch::full_snapshot(...)`
  - `ThreadViewPatch::turn(...)`
  - `ThreadViewPatch::lifecycle(...)`
  - `emit_thread_view_turn_patch(...)`
  - `emit_thread_view_lifecycle_patch(...)`
  - `emit_thread_view_full_snapshot_patch(...)`
- Remove or make private the broad `thread_view_patch_event(state, thread_id)` helper so high-frequency paths cannot accidentally emit full-thread patches.
- Add backend guardrail tests proving:
  - `record_pending_user_input` returns a turn-scoped patch with no `rows`
  - assistant delta handling emits a turn-scoped patch with no `rows`
  - item upsert and turn status handling emit turn-scoped patches with no `rows`
  - approval created/resolved and live-state changes emit lifecycle-scoped patches with no rows/items
  - full-snapshot patches are only used by explicit full snapshot/reconciliation code
- Add payload-budget tests using serialized JSON size for representative large-thread operations:
  - lifecycle patch stays small
  - pending user input/send-start patch stays bounded
  - assistant delta patch size scales with the active turn, not the full thread
- Update frontend tests and helpers to assert `payload.scope` where `thread_view.patch` is emitted or consumed.
- Update `apps/web/src/timeline/reducer.ts` so `thread_view.patch` application branches on explicit scope, not `rows` presence.
- Update `apps/web/src/threads/events.ts` to treat lifecycle fields as the source for runtime/read derivations and ignore row payloads for sidebar status decisions.

Exit criteria:

- There is no production call path that can emit a full-thread `thread_view.patch` without using a full-snapshot-specific function name.
- Focused backend tests fail if a send, delta, item upsert, approval, or live-state change emits a full `rows` payload.
- Focused frontend tests fail if `thread_view.patch` handling regresses to scope inference from optional payload fields.
- `cargo fmt` passes.
- Focused gateway tests pass, including `cargo test -p kodex-gateway thread_view` and the SSE route tests around selected-thread patch replay/refresh recovery.
- Focused web tests pass for `apps/web/src/events/stream.test.ts`, `apps/web/src/timeline/reducer.snapshot.test.ts`, `apps/web/src/timeline/reducer.lifecycle.test.ts`, `apps/web/src/threads/events.test.ts`, and app-level composer/timeline tests that emit projection patches.

### 2. Deduplicate Selected-Thread Live Events Across Streams

Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/routes/mod.rs`, `apps/web/src/events/stream.ts`, `apps/web/src/App.tsx`, selected-thread timeline hooks/tests, subagent/sidebar invalidation tests.

Work:

- Add an SSE query parameter for global streams, for example `excludeThreadId=<threadId>`.
- Extend the gateway event-stream query parser and `event_matches` logic so:
  - `/v1/events?threadId=t1` remains the selected-thread stream and includes selected-thread replay/refresh semantics.
  - `/v1/events?excludeThreadId=t1` remains a global operational stream but does not deliver events whose `threadId` is `t1`.
  - if both `threadId` and `excludeThreadId` are supplied, reject the request with a clear `400` or ignore `excludeThreadId` with an explicit test; prefer rejecting because it avoids ambiguous semantics.
- Update `createEventStreamClient` to accept `excludeThreadId` and include it in `eventStreamUrl`.
- Update `App.tsx` so the global stream is recreated when the selected thread changes and passes `excludeThreadId: selectedThreadId` when a selected thread exists.
- Ensure selected-thread live handling remains exclusively on the selected-thread stream while selected; global stream handlers should still process other threads for sidebar, notifications, queue, pins, automations, skills, MCP, and rate limits.
- Add app-level tests proving:
  - selecting a thread creates one selected-thread stream and one global stream excluding that selected thread
  - a selected-thread `thread_view.patch` delivered on the selected stream updates the timeline
  - the same selected-thread patch is not routed through the global stream when exclusion is active
  - switching selected threads closes/replaces the old excluded global stream and selected stream cleanly
  - non-selected thread events still update sidebar/read/notification state through the global stream
- Preserve selected-thread refresh recovery: lagged selected streams still emit `thread_view.refresh_required`, and global exclusion must not suppress recovery for the selected stream.
- Use `$agent-browser` validation after implementation to exercise a large selected thread on a narrow/mobile viewport:
  - open a large thread
  - send a short running prompt
  - verify the user bubble appears, streaming continues, scrolling remains usable, and duplicate selected-thread patch handling is not visible in dev counters or logs if instrumentation is available

Exit criteria:

- Selected-thread patch events are not parsed through both the global and selected EventSource while a selected stream is active.
- SSE route tests cover include/exclude behavior, invalid query combinations, selected replay, and non-selected global delivery.
- Frontend stream tests cover URL construction and reconnect behavior with `excludeThreadId`.
- App-level tests cover thread switching, selected timeline updates, and non-selected sidebar updates.
- Focused mobile/narrow browser validation is documented in the implementation notes.

## Verification

Run the narrowest checks that cover changed contracts first:

- `cargo fmt`
- `cargo test -p kodex-gateway thread_view`
- `cargo test -p kodex-gateway sse`
- `cd apps/web && npm test -- --run src/events/stream.test.ts src/timeline/reducer.snapshot.test.ts src/timeline/reducer.lifecycle.test.ts src/threads/events.test.ts`
- `cd apps/web && npm test -- --run src/App.mvp.timeline.test.tsx src/App.mvp.composer-input.test.tsx src/App.subagents.test.tsx`
- `cd apps/web && npm run build`

If public DTO fields change:

- run the gateway locally
- regenerate `/openapi.json` and `apps/web/src/api/generated/schema.ts`
- include generated artifacts in the implementation change

Browser validation:

- Use `$agent-browser` against the local app after the focused tests pass.
- Validate desktop fine pointer and narrow/mobile viewport behavior for selected-thread streaming.
- For mobile validation, prefer a large real or synthetic thread that previously reproduced duplicate patch work.

## Risks And Open Questions

- Adding `scope` to `ThreadViewPatch` may change generated OpenAPI types. That is acceptable if the implementation regenerates the contract and updates frontend usage in the same change.
- Recreating the global EventSource on selected-thread changes can briefly miss global events. The reconnect cursor must be preserved so the replacement stream resumes from the last observed global cursor.
- Some global operational events may have `threadId` equal to the selected thread but still affect app-wide state. The selected-thread stream must carry those events, or the exclusion list must exempt truly global events such as account/rate-limit and skills/MCP changes.
- Tests that currently fabricate `thread_view.patch` payloads without full required fields should be updated instead of weakening the new contract.

## Next Steps For Later Planning

After milestones 1 and 2 are complete, another agent should create a follow-on plan for the remaining audit milestones. Suggested scope:

- Snapshot payload diet:
  - remove or gate duplicated `timeline.items` data when `rows` already carry renderable canonical payloads
  - separate display DTOs from debug/raw payload DTOs
  - add serialized-size regression tests for large thread detail responses
- Timeline reducer performance:
  - coalesce same-frame turn patches before reducer application
  - maintain row indexes incrementally instead of rebuilding from all rows on each upsert
  - add deterministic reducer budget tests with a synthetic large thread
- Query/cache invalidation cleanup:
  - extract typed event-to-cache routing from `App.tsx`
  - require cache patching or documented narrow invalidation for each event kind
  - add tests asserting streaming patches do not refetch sidebar/project/chat lists except for explicitly missing metadata
- Large-file cleanup:
  - split `App.tsx` into stream, selection, sidebar live update, optimistic composer, and subagent discovery hooks
  - split `events.rs` by event normalization, thread-view emission, read state, notifications, and queue integration
  - split `thread_view.rs` by storage, row construction, patch construction, and projection tests
- Observability:
  - add dev-only counters for SSE event rate, patch bytes, reducer time, invalidation count, duplicate selected/global event count, and browser long tasks
  - preserve these as diagnostics rather than correctness dependencies

The next plan should start from the post-milestone-2 code, not from the current mixed state, so it can avoid designing around ambiguous patch scope or duplicate selected/global stream delivery.

## Completion Notes

- Added explicit `ThreadViewPatchScope` values for `full_snapshot`, `turn`, and `lifecycle` patches.
- Added backend validation so invalid scope/payload combinations cannot be emitted as `thread_view.patch`.
- Removed the ambiguous high-frequency full-patch emission helper in favor of an explicitly named full-snapshot emitter.
- Updated frontend timeline reduction to require explicit patch scope instead of inferring behavior from optional `rows` fields.
- Added `excludeThreadId` support to `/v1/events` and `createEventStreamClient`.
- Recreated the global stream on selected-thread changes while preserving the global cursor.
- Routed selected-thread shell reactions through the selected-thread stream so the global stream can exclude the selected thread without losing selected-thread queue, approval, sidebar, metadata, and subagent-discovery behavior.
- Regenerated frontend OpenAPI types from a temporary local gateway.
- Verified with focused backend tests, focused frontend tests, production build, and browser validation on a large reference thread.
