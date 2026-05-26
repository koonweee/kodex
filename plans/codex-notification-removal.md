# Codex Notification Removal Plan

## Status

Complete.

## Context

The gateway currently persists every app-server notification as a generic `codex.notification` event before emitting normalized gateway events. That row has served several roles at once:

- a monotonic cursor source for live notification handling,
- a selected-thread replay refresh trigger,
- a debug record for `/v1/debug/events`,
- historical raw app-server payload storage.

This mixed role caused the local `gateway.db` to retain old transcript and image payloads. The user decision for this plan is explicit: remove durable `codex.notification` events entirely. Retention automation is intentionally out of scope for now; this plan may include one-time cleanup of existing `codex.notification` rows, but not a recurring pruning job.

## Current State

Code-established facts:

- `apps/gateway/src/events.rs::ingest_inbound` calls `persist_notification_cursor` for every `InboundMessage::Notification`, broadcasts that raw event on `state.events`, and passes its `seq` into `normalized_timeline_events`.
- `apps/gateway/src/events.rs::persist_notification_cursor` stores `kind = "codex.notification"`. Transcript-like methods are redacted to cursor metadata, while non-transcript methods persist the full `params`.
- `apps/gateway/src/events.rs::is_thread_view_replay_refresh_trigger` uses transcript-shaped `codex.notification` rows as selected-thread replay refresh triggers.
- `apps/gateway/src/events.rs::append_timeline_event` already stores transcript timeline event observations as compact `thread_view.cursor` rows instead of durable `timeline.item_*` payload rows.
- `apps/gateway/src/events.rs::thread_view_patch_event` emits synthetic `thread_view.patch` events with `state.store.latest_event_seq()` and does not persist full patch payloads.
- Normal `/v1/events` replay uses `is_operational_replay_event`; `codex.notification` is not in that allowlist.
- The web event stream in `apps/web/src/events/stream.ts` subscribes to named gateway events and does not subscribe to `codex.notification`.
- Current tests in `apps/gateway/src/events.rs` and `apps/gateway/src/routes/mod.rs` still assert raw `codex.notification` persistence, debug replay, and broadcast order.
- The local database still contains old `codex.notification` rows, including pre-redaction transcript/image payloads. Removing current code writes will not delete those historical rows by itself.

Constraints:

- App-server remains the durable owner of transcript history.
- Visible thread rendering must continue to consume gateway `ThreadView` snapshots, `thread_view.patch`, and `thread_view.refresh_required` convergence signals only.
- Gateway-owned coordination state such as approvals, queue rows, thread reads, pins, automations, MCP state, account rate limits, skills, and thread metadata must keep named durable events where replay is product behavior.
- Do not add a general retention job or background vacuum policy in this plan.

## Target Shape

- Production code never appends `kind = "codex.notification"` to `events`.
- Transcript app-server notifications that affect thread view state persist only compact `thread_view.cursor` rows when a durable replay cursor is needed.
- Non-transcript app-server notifications either emit a named gateway event or are ignored after logging; unhandled raw app-server notifications are not durable product state.
- Selected-thread reconnect recovery converges from `thread_view.cursor` and named gateway events, not from raw notification rows.
- `/v1/debug/events` remains a raw event-store inspection route for named persisted gateway events and cursor rows; it no longer promises raw app-server notification history.
- Existing `codex.notification` rows can be deleted with a one-time cleanup after the code no longer depends on them.

## Non-Goals

- Do not add recurring event retention or automatic compaction.
- Do not redesign the web timeline renderer.
- Do not remove Web Push notification support; this plan concerns the `codex.notification` event kind, not the `notifications` module or `/v1/notifications/*` routes.
- Do not change app-server schemas or the configured Codex binary version.
- Do not expose raw app-server payload replay through a new table unless a later debug product decision asks for bounded debug capture.

## Milestones

### 1. Lock The New Event Contract

- Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/routes/mod.rs`, and existing event/replay tests.
- Work:
  - Update tests that currently expect `codex.notification` so they instead expect named gateway events, `thread_view.cursor`, `thread_view.patch`, or no durable row.
  - Add a regression test for `item/agentMessage/delta` proving:
    - no `codex.notification` row is persisted,
    - no delta text is persisted in `events`,
    - selected-thread live subscribers still receive a `thread_view.patch`,
    - selected-thread replay after a missed cursor emits `thread_view.refresh_required`.
  - Add tests for MCP lifecycle, account rate limits, thread metadata, skill changes, and approval/server-request flows proving they still emit named durable events without raw notification rows.
  - Add or update a guard test that fails if production gateway or web code reintroduces `codex.notification` as a normal event kind.
- Exit criteria:
  - Focused tests fail against the current implementation before refactoring.
  - The tests document the replacement behavior for transcript, operational, and ignored app-server notifications.

### 2. Replace Raw Notification Persistence With Explicit Cursor And Named Events

- Scope: `apps/gateway/src/events.rs` and any helper tests in `apps/gateway/src/routes/mod.rs`.
- Work:
  - Remove `persist_notification_cursor` or replace it with explicit helpers:
    - one helper that appends `thread_view.cursor` for transcript/thread-view-changing methods that need a durable replay signal,
    - one helper path that emits named gateway events for operational notifications.
  - Restructure `ingest_inbound` so notification handling no longer requires a raw event `seq` up front.
  - Make `timeline_item_delta_event` append its own compact `thread_view.cursor` before recording the delta patch, rather than using a `codex.notification` cursor.
  - Keep existing `append_timeline_changed_cursor` semantics for item upsert, turn upsert, and thread status paths, but remove any dependence on raw notification replay.
  - Continue broadcasting `thread_view.patch`, named operational events, queue events, read events, notification planning events, and skill-change events as before.
  - For unrecognized app-server notification methods, log at an appropriate tracing level and do not persist a generic fallback event.
- Exit criteria:
  - `rg '"codex.notification"|codex\\.notification' apps/gateway/src apps/web/src` finds no production dependency outside tests or migration assertions that intentionally prove absence.
  - Selected-thread live and replay tests pass through `thread_view.cursor` and `thread_view.refresh_required`.
  - Normal `/v1/events` replay remains operational-only and named-event based.

### 3. Simplify Debug Replay And Historical Event Assumptions

- Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/routes/events.rs`, route tests in `apps/gateway/src/routes/mod.rs`, and docs if route behavior is described.
- Work:
  - Update `/v1/debug/events` tests so debug replay returns persisted named events and cursor rows, not raw app-server notifications.
  - Remove test fixtures that manually append `codex.notification` as a representative transcript event; use `thread_view.cursor` for transcript replay-trigger fixtures instead.
  - Audit helper names and comments so `notification` does not imply durable raw app-server notification storage.
  - If README or plan comments describe raw `codex.notification` debug replay, update them to say raw app-server notification capture is no longer persisted.
- Exit criteria:
  - `/v1/debug/events` behavior is consistent with the event store's new contents.
  - No test relies on `codex.notification` to simulate product replay behavior.

### 4. One-Time Data Cleanup

- Scope: local SQLite event store cleanup guidance and optional gateway store helper if implementation chooses to automate a one-shot operation.
- Work:
  - After implementation no longer reads or writes `codex.notification`, delete existing rows with:
    - `DELETE FROM events WHERE kind = 'codex.notification';`
  - Checkpoint WAL and compact manually or through an explicit operator step:
    - `PRAGMA wal_checkpoint(TRUNCATE);`
    - `VACUUM;`
  - Verify the cleanup does not delete named operational events such as `account.rate_limits_updated`, `timeline.thread_metadata`, MCP events, queue events, approvals, read events, pins, automations, skills, and warnings.
  - Do not add recurring pruning, scheduled compaction, or retention configuration in this milestone.
- Exit criteria:
  - Local inspection shows `SELECT COUNT(*) FROM events WHERE kind = 'codex.notification';` returns `0`.
  - `PRAGMA quick_check;` returns `ok` after compaction.
  - Database size reflects removal of historical raw notification rows.

### 5. Verification And Review

- Scope: focused backend and frontend checks plus independent review.
- Work:
  - Run `cargo fmt`.
  - Run focused gateway tests around event ingest, SSE replay, debug replay, account/MCP/thread metadata, and selected-thread recovery.
  - Run relevant frontend tests for event stream subscriptions, thread event helpers, account rate limit updates, and timeline guardrails.
  - Run broader `cargo test` and `cd apps/web && npm test` if focused checks expose shared contract risk.
  - Perform an independent review pass before marking the plan complete.
- Exit criteria:
  - Focused backend and frontend checks pass.
  - Review finds no remaining product dependency on `codex.notification`.
  - Any docs touched during implementation match the final event-store behavior.

## Verification

- `cargo fmt`
- Focused gateway tests:
  - `cargo test -p kodex-gateway events`
  - focused route/SSE tests in `apps/gateway/src/routes/mod.rs` covering `/v1/events` and `/v1/debug/events`
- Focused frontend tests:
  - `cd apps/web && npm test -- src/events/stream.test.ts src/threads/events.test.ts src/account/rateLimits.test.ts src/timeline/threadViewGuard.test.ts`
- Data cleanup checks:
  - `sqlite3 ~/.kodex/gateway.db "SELECT COUNT(*) FROM events WHERE kind = 'codex.notification';"`
  - `sqlite3 ~/.kodex/gateway.db "PRAGMA quick_check;"`

## Risks And Open Questions

- Some tests currently use `codex.notification` as a cheap fixture for transcript history. Those tests need to be converted carefully so they keep testing replay/recovery rather than preserving the old event kind.
- `thread_view.cursor` volume can still grow with transcript activity. That is acceptable for this plan because recurring retention is explicitly out of scope.
- Dropping unrecognized app-server notifications means `/v1/debug/events` will no longer be a raw app-server notification audit log. This is intentional for storage safety, but future debugging needs may justify a separate bounded debug capture design.
- Existing local databases need one-time cleanup after the code refactor. Code changes alone will only prevent new `codex.notification` rows.
