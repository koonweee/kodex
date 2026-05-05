# Chat Render Order and Subscription Parity Plan

## Scope

Fix intermittent chat timeline render-order issues where user and assistant messages can jump to the wrong visual position until refresh or thread switch. The fix covers the reproduced frontend ordering bug and the selected-thread subscription divergence from upstream Codex TUI behavior.

This plan is based on the agent-browser repro in `dogfood-output/chat-order/` and the comparison against Codex app-server/TUI behavior:

- App-server `thread/start`, `thread/resume`, and `thread/fork` attach live turn/item notifications.
- App-server `thread/read` is snapshot/read-only.
- Codex TUI attaches live selected threads with `thread/resume` and treats `thread/read` fallback as replay-only.
- Kodex web currently loads selected timelines through snapshot reads and selected-thread SSE, but only resumes selected `notLoaded` threads.

## Goals

- Preserve stable visual order for existing timeline items when late or stale live events merge into snapshot-built state.
- Attach selected active threads to app-server live notifications before relying on selected-thread SSE for live updates.
- Keep snapshot refresh as the recovery mechanism for reconnect uncertainty and `timeline.snapshot_required`.
- Avoid duplicate app-server subscriptions when a selected thread is reselected, refreshed, or switched away/back.
- Verify the original four browser hypotheses become either fixed or intentionally stable.

## Non-Goals

- Do not replace SSE with WebSocket.
- Do not reintroduce persisted timeline replay as the canonical selected-thread loader.
- Do not build a multi-client cross-device event bus beyond current gateway behavior.
- Do not change generated frontend API types except where a public gateway DTO actually changes.

## Milestone 1: Stable Timeline Item Display Order

Status: Proposed

Failing tests first:

- Add a reducer test that reproduces the browser failure:
  - apply initial snapshot with `Old question`, `Old answer`
  - apply live assistant item `Streaming answer` with seq `20`
  - apply full snapshot with `Old question`, `Old answer`, `New question`, `Streaming answer`
  - apply stale live upsert for the same assistant item with seq `10`
  - expect derived visible rows to remain `Old question`, `Old answer`, `New question`, `Streaming answer`
- Add a reducer test that a lower-seq non-delta `item/started` does not regress a completed snapshot item text/status.
- Keep existing optimistic-user-message and snapshot reconciliation tests passing.

Implementation:

- Update `mergeTimelineItem` so an existing visible item keeps its established display `seq` when merged with later events for the same app-server item.
- Add a named helper for this rule, such as `mergeTimelineDisplaySeq(existing, incoming)`, so `seq` is documented as UI display order rather than raw event freshness.
- Add stale-update handling for completed snapshot items:
  - preserve completed status when an older non-delta event arrives
  - preserve completed text when the incoming event does not add useful new content
  - continue allowing real deltas to append while an item is still running
- Do not change new-item ordering; items that do not already exist still enter at the incoming event seq or snapshot synthetic seq.

Exit conditions:

- Focused reducer tests fail before the implementation and pass after it.
- `npm test` passes for `apps/web`.
- Manual agent-browser Hypothesis 1 no longer reproduces row movement.
- Switching away/back does not need to repair a corrupted order caused by stale lower-seq item merges.

Agent-browser verification:

- Use the existing mock-gateway harness or equivalent `agent-browser --init-script` setup.
- Scenario H1:
  - select `Implement frontend`
  - emit high-seq live assistant item
  - trigger full snapshot refresh
  - emit lower-seq live upsert for the same assistant item
  - expected visible order: `Old question`, `Old answer`, `New question`, `Streaming answer`
- Capture a screenshot at `dogfood-output/chat-order/screenshots/h1-fixed-stable-order.png`.

## Milestone 2: Selected Active Thread Live Attach Parity

Status: Proposed

Failing tests first:

- Add an app-level frontend test for selecting an `active` thread:
  - mocked thread list returns an active selected thread
  - expected behavior calls `POST /v1/threads/{threadId}/resume` or the chosen attach endpoint
  - selected-thread detail still loads and renders the snapshot
- Add a frontend dedupe test:
  - repeated renders, same-thread reselection, or snapshot refresh must not issue duplicate attach calls while an attach is already in flight or already succeeded for that thread.
- Add a gateway test if backend attach semantics change:
  - repeated resume/attach for the same thread must not create duplicate app-server notification subscriptions.

Implementation:

- Treat selected `active` threads the same as selected `notLoaded` threads for live attachment.
- Prefer reusing `POST /v1/threads/{threadId}/resume` as the attach operation unless gateway internals require a new explicit attach route.
- Add frontend in-flight and attached-thread tracking so selection effects are idempotent:
  - call attach when selected thread status is `notLoaded` or `active`
  - skip if the same thread is already attaching
  - skip if this gateway session has already attached that thread
  - clear stale tracking only when the gateway reports a terminal attach failure or the thread is archived
- Keep `GET /v1/threads/{threadId}` as a snapshot/read operation. Do not make snapshot reads implicitly attach app-server subscriptions.
- Ensure timeline snapshot loading remains independent enough that selecting a thread still shows stored history quickly even if live attach is slow.

Exit conditions:

- Active selected threads attach live without requiring a user send action or manual refresh.
- No duplicate app-server subscriptions are created by repeated selection, snapshot refresh, or reconnect.
- Existing `notLoaded` resume behavior still works.
- Frontend tests and relevant gateway tests pass.
- `npm test` passes for `apps/web`; `cargo test` passes if gateway code changes.

Agent-browser verification:

- Scenario H3:
  - open the mocked app with `Second thread` returned as `active`
  - verify a single attach/resume call is made for `thread-2`
  - emit a live thread-2 assistant update without `timeline.snapshot_required`
  - expected visible state includes the live update without waiting for a snapshot refresh
  - verify repeated click on `Second thread` does not add another attach/resume call
- Capture a screenshot at `dogfood-output/chat-order/screenshots/h3-fixed-active-live-attach.png`.

## Milestone 3: Reconnect and Snapshot Refresh Stability

Status: Proposed

Failing tests first:

- Add or update selected timeline hook tests so reconnect status triggers exactly one snapshot refetch per reconnect cycle.
- Add a test proving stale live events received after reconnect cannot reorder snapshot-refreshed items.
- Keep the existing event stream test that reconnects from the last seen sequence.

Implementation:

- Leave `createEventStreamClient` cursor behavior intact: reconnect from the last seen sequence.
- Keep the selected-thread `onStatusChange("reconnecting")` snapshot refresh behavior.
- Debounce or coalesce overlapping snapshot refresh requests if tests reveal duplicate `GET /v1/threads/{threadId}` calls from reconnect plus `timeline.snapshot_required`.
- Ensure queued live events are cancelled when switching threads and cannot apply to a stale selected-thread token.

Exit conditions:

- Reconnect still opens SSE with the last seen cursor.
- Snapshot refresh remains the recovery path for uncertain selected-thread stream state.
- Overlapping reconnect and `snapshot_required` events do not create visible order regressions or unnecessary duplicate refreshes.
- Focused hook/stream tests pass.

Agent-browser verification:

- Scenario H2:
  - select `Implement frontend`
  - emit a live item at seq `20`
  - fail the selected-thread EventSource
  - verify a snapshot refresh runs
  - verify reconnect URL contains `cursor=20&threadId=thread-1`
  - expected visible order remains stable after refresh
- Capture a screenshot at `dogfood-output/chat-order/screenshots/h2-fixed-reconnect-stable.png`.

## Milestone 4: End-to-End Regression Browser Pass

Status: Proposed

Failing tests first:

- Add an agent-browser script or documented command sequence that executes the four repro scenarios against the local Vite app and mocked gateway harness.
- The script should fail or print a nonzero result if any expected row order, attach call count, or reconnect URL check fails.

Implementation:

- Promote the current dogfood harness into a repeatable verification fixture if it remains useful:
  - keep it under a tracked test/support location if it becomes part of regular verification
  - otherwise document the manual agent-browser commands in this plan and keep screenshots as local dogfood artifacts only
- Run all four browser scenarios after Milestones 1-3:
  - H1 stable order after stale lower-seq merge
  - H2 reconnect snapshot recovery with stable order
  - H3 active thread live attach without waiting for snapshot-required
  - H4 switch away/back remains clean and does not mask an underlying ordering bug
- Inspect browser console and errors after the run.

Exit conditions:

- All four agent-browser scenarios pass.
- Screenshots are captured for the fixed states:
  - `h1-fixed-stable-order.png`
  - `h2-fixed-reconnect-stable.png`
  - `h3-fixed-active-live-attach.png`
  - `h4-fixed-switch-back-clean.png`
- Browser console has no unexpected app errors.
- `npm test`, `npm run build`, and any relevant `cargo test` pass.
- Plan status is updated in `plans/index.md` when implementation starts and when complete.

## Review Checklist

- Confirm `seq` semantics are not used elsewhere as raw event freshness after the reducer change.
- Confirm completed item stale-update handling does not block legitimate streaming deltas.
- Confirm active-thread attach is idempotent on both frontend and gateway sides.
- Confirm snapshot reads remain read-only and do not silently create app-server live subscriptions.
- Confirm agent-browser H1-H4 results match the expected fixed behavior, not just screenshots of a visually acceptable state.
