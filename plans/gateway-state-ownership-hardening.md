# Gateway State Ownership Hardening Plan

## Status

Proposed.

## Context

Recent review found three high-value state ownership gaps where the web client still carries shared lifecycle or routing decisions that should be gateway-owned:

- Read/unread state is persisted in the gateway, but browser tabs still derive completed-agent-turn sequence and unread badges from local cache and event order.
- Current-turn command routing still uses browser-local `timeline.activeTurnId` for stop/interrupt paths.
- Existing-thread composer settings can be locally overridden and later sent as full turn options, allowing stale tabs to silently overwrite newer shared settings.

This plan is intentionally not a cosmetic cleanup. The goal is to harden same-gateway, same-user multi-client correctness. The frontend may keep visual, per-tab state such as drafts, attachments, scroll, hover, modals, and pending button spinners, but any state that affects another tab, future turn routing, read receipts, badges, notifications, or durable thread execution settings must be owned and reconciled by the gateway or app-server.

Relevant code seams:

- Frontend shell and shared state projection:
  - `apps/web/src/App.tsx`
  - `apps/web/src/threads/useThreadReadState.ts`
  - `apps/web/src/threads/cache.ts`
  - `apps/web/src/notifications/useKodexNotifications.ts`
  - `apps/web/src/notifications/unreadAgentMessages.ts`
  - `apps/web/src/composer/useComposerOrchestration.ts`
  - `apps/web/src/composer/useComposerSettingsState.ts`
  - `apps/web/src/composer/settings.ts`
- Gateway coordination and app-server routing:
  - `apps/gateway/src/routes/threads.rs`
  - `apps/gateway/src/routes/turns.rs`
  - `apps/gateway/src/turn_lifecycle.rs`
  - `apps/gateway/src/thread_view.rs`
  - `apps/gateway/src/queue.rs`
  - `apps/gateway/src/events.rs`
  - `apps/gateway/src/notifications.rs`
  - `apps/gateway/src/store.rs`
- Public contract and generated client:
  - `apps/gateway/src/api.rs`
  - `apps/web/src/api/client.ts`
  - `apps/web/src/api/generated/schema.ts`
  - `apps/web/src/events/stream.ts`

Related plans that this plan must not regress:

- [Thread lifecycle single source of truth](thread-lifecycle-single-source-of-truth.md)
- [Gateway queue persistence](gateway-queue-persistence.md)
- [Default queued composer input restoration](default-queued-composer-input.md)
- [Gateway pending steer commit](gateway-pending-steer-commit.md)
- [Server-owned thread settings](server-owned-thread-settings.md)
- [App-server resume/fork and settings simplification](app-server-resume-fork-settings-simplification.md)
- [Performance overhaul](performance-overhaul.md)

## Current State

Code-established facts:

- `apps/gateway/src/routes/threads.rs::mark_thread_seen` writes `thread_reads.seen_completed_agent_turn_seq`, and `apps/gateway/src/store.rs::mark_thread_seen_completed_agent_turns` uses `max(...)` to make read markers monotonic.
- `apps/web/src/threads/useThreadReadState.ts::applyCompletedAgentTurnEvent` computes `nextCompletedAgentTurnSeq` from cached `ThreadSummary` fields and the local selected-thread id, then mutates Query cache before persisting.
- `apps/web/src/notifications/useKodexNotifications.ts` derives foreground notifications and app badge counts from local known thread groups, so a second tab can keep stale unread state until a later refetch.
- `apps/gateway/src/thread_view.rs` already owns canonical selected-thread live state, including `active_turn_id` and `live_state`, and `apps/gateway/src/turn_lifecycle.rs` has helpers that can inspect gateway/app-server state.
- `apps/web/src/composer/useComposerOrchestration.ts::handleStopTurn` calls `interruptTurn(selectedThreadId, activeSelectedTurnId)`, where `activeSelectedTurnId` comes from frontend timeline state.
- `apps/gateway/src/routes/turns.rs::interrupt_turn` forwards the supplied turn id directly to app-server.
- `apps/web/src/composer/useComposerSettingsState.ts` keeps `selectedThreadComposerOverride` in React state, while `apps/gateway/src/store.rs::save_thread_turn_options` writes full submitted `TurnStartOptions` into `thread_composer_settings`.
- `plans/app-server-resume-fork-settings-simplification.md` already proposes narrowing `thread_composer_settings` to fallback/submitted options rather than treating it as canonical app-server thread settings.
- `plans/performance-overhaul.md` has active composer-send work. This plan owns correctness rules for shared pending/routing/settings state; performance work must preserve those rules.

Constraints from `AGENTS.md`:

- Shared lifecycle decisions, queued input, read receipts, thread settings, and command routing belong in the gateway or upstream app-server.
- Browser-local state is appropriate only for drafts, focus, hover, modals, scroll, drag interactions, unsent attachments, and similar per-tab concerns.
- Behavior-changing shared thread state needs same-user, two-tab test coverage.
- OpenAPI DTOs are the public contract; frontend API types must be generated, not hand-written.
- Frontend visible timeline rendering must consume canonical gateway thread view snapshots/patches, not raw app-server lifecycle events.

## Principles

- Start each behavior-changing milestone with failing tests where practical.
- Do not add browser-only fallbacks for shared state.
- Do not make the browser decide shared command routing from local `activeTurnId`.
- Do not let stale tabs silently overwrite newer shared settings.
- Prefer gateway commands that atomically inspect current gateway/app-server state and return or emit the authoritative result.
- Keep app-server as durable transcript owner. This plan does not reintroduce persisted browser transcript history or raw timeline replay.
- Preserve local/VPN-only deployment assumptions; this is not public internet hardening.

## Non-Goals

- Do not move local drafts, unsent attachments, scroll position, expanded timeline rows, debug panel state, or drag/hover state into the gateway.
- Do not change automation scheduling semantics beyond preserving authoritative turn options and queue routing.
- Do not implement multi-gateway synchronization.
- Do not make sidebar project drag order shared unless a separate product decision says project order should sync across browsers. `localStorage` project order is out of scope for this high-value pass.
- Do not replace the active performance plan. Where scopes overlap, this plan defines correctness constraints and the performance plan may optimize within them.

## Milestones

### 1. Lock The Ownership Contract With Tests And Guards

Scope: backend route/event tests, frontend state tests, and static ownership guardrails.

Work:

- Add backend tests in `apps/gateway/src/routes/mod.rs`, `apps/gateway/src/routes/threads.rs`, and `apps/gateway/src/routes/turns.rs` proving:
  - marking a thread seen broadcasts a canonical read-state update to other clients;
  - a current-turn interrupt command uses gateway/app-server authoritative active state, not a stale browser turn id;
  - stale full thread settings submitted from a browser cannot overwrite newer shared settings without version/merge validation.
- Add frontend tests in `apps/web/src/App.mvp.timeline.test.tsx`, `apps/web/src/App.mvp.composer-input.test.tsx`, and `apps/web/src/App.mvp.composer-settings.test.tsx` proving:
  - unread/badge state converges from gateway events or refetches across two mounted clients;
  - stop/interrupt UI calls a gateway-owned current-turn command instead of passing local `activeTurnId`;
  - selected-thread setting changes are reconciled from gateway state and do not survive as hidden local overrides after server metadata changes.
- Add or extend guard tests so production frontend code cannot reintroduce:
  - local completed-turn sequence increments for durable read state;
  - direct UI usage of `/turns/{turnId}/interrupt` for the selected thread stop control;
  - hand-written DTOs for new read/settings/command responses.
- Add a short `AGENTS.md` guardrail update if implementation introduces new canonical event names or command routes.

Exit criteria:

- New tests fail before implementation for the confirmed gaps.
- Test names describe ownership invariants, not only UI symptoms.
- Guardrails are scoped enough to avoid blocking debug-only or test-only utilities.

### 2. Make Read Receipts And Unread Badges Gateway-Canonical

Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/store.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/notifications.rs`, `apps/web/src/threads/useThreadReadState.ts`, `apps/web/src/threads/cache.ts`, and notification modules.

Work:

- Add a canonical gateway event for read-state changes, for example `thread.read_updated`, carrying at least:
  - `threadId`
  - `seenCompletedAgentTurnSeq`
  - current `lastCompletedAgentTurnSeq` when known
  - `unreadCompletedAgentTurn`
  - a gateway event `seq`
- Make `mark_thread_seen` append and broadcast that event after the store write.
- Allow selected-thread mark-seen calls to omit a browser-computed sequence. The gateway should compute the current completed-agent-turn count from its canonical known state, app-server readback, or the existing count helper.
- Stop `useThreadReadState.ts` from deriving durable `nextCompletedAgentTurnSeq` by adding one to cached state. It may optimistically show a per-tab projection only if the gateway event/refetch remains authoritative and cannot make another tab stale.
- Update `applyThreadReadState`, sidebar thread cache merge helpers, notification badge derivation, and foreground notification suppression to consume gateway read-state events.
- Ensure background push rechecks in `apps/gateway/src/notifications.rs` use the same canonical read-state source before delivery.
- Include same-user two-client tests:
  - tab A opens/marks a thread seen;
  - tab B receives the read event or refetches and clears unread/badge state without reload;
  - a late sidebar snapshot cannot resurrect unread state older than the read event.

Exit criteria:

- Backend tests prove `POST /v1/threads/{threadId}/seen` is monotonic, broadcasts canonical read state, and replays enough operational state for reconnecting clients.
- Frontend tests prove badges and unread indicators converge across two mounted clients.
- Foreground notification tests prove selected-thread terminal events do not create a lasting stale badge in another mounted client after read-state convergence.
- `thread_reads` remains gateway-owned persistence; no browser storage or local-only read receipt is introduced.

### 3. Move Selected-Thread Stop/Interrupt To A Gateway-Owned Current-Turn Command

Scope: `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/thread_view.rs`, `apps/gateway/src/events.rs`, `apps/web/src/api/client.ts`, `apps/web/src/composer/useComposerOrchestration.ts`, and generated OpenAPI.

Work:

- Add a selected-thread-safe command such as `POST /v1/threads/{threadId}/interrupt-current`.
- In the gateway route:
  - inspect `ThreadViewStore` active state when loaded and fresh;
  - reconcile with app-server when active state is unknown, stale, or contradictory;
  - interrupt only the authoritative active turn;
  - return an explicit disposition, such as `interrupted`, `idle`, `notLoaded`, or `staleStateRefreshed`.
- Keep the raw `POST /v1/threads/{threadId}/turns/{turnId}/interrupt` route only for explicit API callers that intentionally name a turn. The web selected-thread stop button should not use it.
- Emit or trigger canonical `thread_view.patch` / read-side effects so both tabs converge after interruption.
- Update `useComposerOrchestration.ts::handleStopTurn` to call the current-turn command with only `selectedThreadId`.
- Remove UI correctness dependencies on frontend `activeSelectedTurnId` for command routing. It may remain a presentation signal for whether to show the Stop affordance.
- Add stale-tab tests:
  - tab A has old `activeTurnId`;
  - tab B or app-server advances to a new active turn or idle;
  - tab A Stop uses gateway state and either interrupts the current turn or returns idle, but never interrupts the stale turn id.

Exit criteria:

- Backend route tests cover active, idle, not-yet-materialized, stale gateway active state, and app-server error cases.
- Frontend tests prove Stop no longer sends a turn id from `timeline.activeTurnId`.
- Generated OpenAPI and `apps/web/src/api/generated/schema.ts` are updated if the route/DTO is new.
- Existing explicit steer and queue tests still pass.

### 4. Version Or Patch-Merge Existing-Thread Settings

Scope: `apps/gateway/src/store.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/routes/composer_settings.rs`, `apps/gateway/src/automations.rs`, `apps/web/src/composer/useComposerSettingsState.ts`, `apps/web/src/composer/settings.ts`, and composer settings tests.

Work:

- Define field-level ownership in code, aligning with `plans/app-server-resume-fork-settings-simplification.md`:
  - app-server thread/config metadata wins when present;
  - gateway SQLite may retain fallback/submitted options for immediate response coherence and automations;
  - browser-local selected-thread overrides are not canonical.
- Rename or document `ThreadComposerSettings` as fallback/submitted options, not canonical thread settings, if that has not already been done by the related plan.
- Introduce a gateway-owned thread settings contract for existing threads. Recommended shape: partial patch with `expectedSettingsVersion`, where the gateway merges against latest app-server/gateway settings and returns a conflict response on stale full writes. Any alternative must still provide the same atomic stale-tab protection and explicit conflict semantics.
- Avoid full local overwrite on normal turn submit:
  - if a submit uses current thread settings unchanged, let the gateway apply latest authoritative settings;
  - if a submit intentionally changes settings, send a patch/version token or an explicit per-turn-only override that is not stored as future thread settings without validation.
- Make selected-thread composer controls derive from canonical `ThreadSummary` metadata plus gateway settings version/fallback metadata, not `selectedThreadComposerOverride` that can outlive server refresh.
- Broadcast or invalidate thread summary/settings state after accepted settings changes so another tab updates without reload.
- Keep draft settings local until real thread creation/submission. Drafts have no durable identity and are not part of this shared-state contract.
- Add two-tab tests:
  - tab A changes model/permissions for an existing thread;
  - tab B sees the canonical change through event/refetch;
  - stale tab B cannot submit a full older options object that silently overwrites tab A's newer settings.

Exit criteria:

- Backend tests prove app-server metadata wins over stored fallback for every covered field: model, reasoning effort, service tier, approval policy, approvals reviewer, and sandbox.
- Backend tests prove stale settings writes conflict or patch-merge safely.
- Frontend tests prove selected-thread settings refresh from server metadata and stale local overrides are cleared.
- Automation tests prove scheduled prompts keep their intentionally retained stored-options behavior.
- OpenAPI and generated frontend types are regenerated for any new settings version/patch DTOs.

### 5. Thin The Frontend To Projections Only

Scope: `apps/web/src/App.tsx`, `apps/web/src/threads/useThreadReadState.ts`, `apps/web/src/threads/cache.ts`, `apps/web/src/notifications/*`, `apps/web/src/composer/useComposerOrchestration.ts`, `apps/web/src/composer/useComposerSettingsState.ts`, and focused tests.

Work:

- Delete or reduce frontend helpers that compute shared truth:
  - local completed-turn sequence increments;
  - stale read projection merges that outrank gateway events;
  - selected-thread composer overrides that survive server metadata refresh;
  - stop/interrupt routing by local active turn id.
- Keep per-tab presentation state explicit:
  - `isComposerSubmitting`
  - pending attachments and object URLs
  - draft text/settings before thread creation
  - modals, hover, scroll, and selected panel state.
- Rework cache merge helpers so gateway event `seq`, settings version, or returned authoritative DTOs decide conflicts where available.
- Ensure late snapshots cannot resurrect older read, settings, pin, queue, or title state after a newer gateway event.
- Keep timeline rendering on canonical `ThreadViewResponse` and `thread_view.patch` only.

Exit criteria:

- `rg` confirms no production frontend code computes a durable completed-turn sequence by incrementing local state.
- `rg` confirms selected-thread Stop uses the current-turn command.
- `rg` confirms no new ad hoc duplicated TypeScript interfaces for new DTOs.
- Focused frontend suites pass for timeline read state, notifications, composer input, composer settings, and queue behavior.

### 6. Contract, Documentation, Browser Validation, And Review

Scope: OpenAPI generation, frontend generated API types, `README.md`, `AGENTS.md`, `plans/index.md`, and browser-observable validation.

Work:

- Regenerate the public API contract after Rust DTO/route changes:
  - start a gateway;
  - inspect `GET /openapi.json`;
  - run `cd apps/web && npm run generate:api`;
  - commit generated `apps/web/src/api/generated/schema.ts` with the implementation when this plan is executed.
- Update `README.md` only if commands, setup, notification behavior, or route semantics need user-facing documentation.
- Update `AGENTS.md` if new canonical event names, settings version rules, or command-routing guardrails are introduced.
- Run `$agent-browser` validation for browser-observable flows:
  - two-tab unread/read convergence;
  - foreground app badge clearing;
  - selected-thread Stop on active and stale states;
  - settings update convergence across two tabs;
  - desktop, narrow fine-pointer, and narrow touch/mobile shapes where controls are affected.
- Run an independent review pass before marking the plan complete.

Exit criteria:

- `cargo fmt`
- Focused backend tests for read receipts, current-turn interrupt, settings version/merge, queue/automation regressions, and OpenAPI route inclusion.
- Full or relevant `cargo test`; rerun with approved escalation if known sandbox-limited tests fail for environment reasons.
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Generated OpenAPI/frontend schema is current.
- `$agent-browser` validation notes are recorded in the plan or implementation summary.
- Independent review finds no major shared-state ownership regression.

## Verification Strategy

Backend:

- `cargo fmt`
- `cargo test -p kodex-gateway thread_read`
- `cargo test -p kodex-gateway thread_input`
- `cargo test -p kodex-gateway composer_settings`
- focused route tests for `interrupt-current`, read-state event replay, settings conflict/merge, and automation option retention
- `cargo test` before completion

Frontend:

- `cd apps/web && npm test -- App.mvp.timeline.test.tsx`
- `cd apps/web && npm test -- App.mvp.composer-input.test.tsx`
- `cd apps/web && npm test -- App.mvp.composer-settings.test.tsx`
- `cd apps/web && npm test -- notifications`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`

Contract:

- Run gateway locally and verify `GET /openapi.json` includes new read/settings/interrupt DTOs.
- `cd apps/web && npm run generate:api` after public DTO changes.

Browser:

- `$agent-browser` two-tab smoke for read receipts, Stop, settings convergence, queue visibility, and notification badge behavior.
- Include responsive checks for affected composer/header controls on desktop fine pointer, narrow fine pointer, and narrow touch/mobile shapes.

## Risks And Open Questions

- `lastCompletedAgentTurnSeq` is a completed-turn count, not a durable upstream turn id. The implementation must avoid treating browser-observed SSE order as durable read state.
- App-server may not expose a cheap current completed-turn count for all cases. If the gateway must fall back to app-server turn listing, keep that fallback named and measured rather than smuggling the computation back into React.
- Current-turn interrupt may need app-server readback when gateway `ThreadView` is unloaded. Keep this correctness-first; optimize later only with a tested authoritative runtime cache.
- Existing-thread settings ownership overlaps with the proposed app-server resume/fork simplification plan. If both are implemented together, update one plan to reference the other rather than splitting the same settings contract across two divergent implementations.
- Settings conflicts need a user-visible path. Recommended behavior is a non-destructive refresh/conflict message that reloads canonical settings and lets the user reapply intentional changes, not silent overwrite.
- Project sidebar order remains browser-local in this plan. If cross-browser project ordering becomes product-important, create a separate gateway-owned preferences plan instead of slipping it into this correctness hardening pass.
