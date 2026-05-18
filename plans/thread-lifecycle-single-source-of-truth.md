# Thread Lifecycle Single Source Of Truth Plan

## Status

Complete.

## Context

Recent selected-thread bugs exposed that Kodex still has too many partial lifecycle truths:

- app-server raw notifications say one thing,
- gateway in-memory `ThreadSessionView` says another,
- persisted gateway events and `thread_runtime_state` can carry older lifecycle facts,
- selected-thread SSE and global SSE can deliver overlapping timeline events,
- the React reducer and row derivation still contain lifecycle reconciliation heuristics.

The target change is a hard simplification: thread, turn, item, and message history should be durable only in app-server. The gateway should own one canonical browser-facing `ThreadView` projection per loaded thread plus gateway-native coordination state. The UI should render that projection and stop reconstructing lifecycle from raw app-server event fragments.

Upstream contract and client reference:

- App-server README: a turn starts with `turn/started`, streams `item/*` events, and ends with `turn/completed`; item lifecycle is separate from turn lifecycle.
- Codex TUI `chatwidget.rs`: the UI has committed transcript cells plus an in-flight active cell, and a single bottom-pane task-running indicator derived from `agent_turn_running` rather than every rendered item independently inferring lifecycle.

## Current State

Code-established facts:

- `apps/gateway/src/thread_session_view.rs` is the current in-memory timeline reducer. It merges app-server snapshots, live item deltas, item started/completed notifications, pending request rows, and turn status into `ThreadTimelineSnapshot` and `ThreadSessionViewPatch`.
- `apps/gateway/src/events.rs` persists raw `codex.notification` events, writes persisted `timeline.snapshot_required` cursors, updates `thread_session_view`, emits synthetic `timeline.projection_patch`, and still updates durable `thread_runtime_state` for queue decisions.
- `apps/gateway/src/routes/threads.rs::apply_thread_detail_response_state` rebuilds `response.timeline` from app-server turns through `thread_session_view::build_thread_timeline`, then overlays pending approvals.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts` fetches a snapshot, opens selected-thread SSE, applies `timeline.projection_patch`, `timeline.item_delta`, `timeline.snapshot`, and `timeline.snapshot_required`, and refetches on uncertainty.
- `apps/web/src/App.tsx` also applies selected-thread `timeline.projection_patch` from the global stream as a fallback, proving lifecycle is currently split across two event consumers.
- `apps/web/src/timeline/reducer.ts` still compares `event.seq`, `state.lastSeq`, and `patch.revision`; it handles snapshots, patches, compact deltas, debug events, stale cursors, missing item removal, active turn clearing, and pending request state.
- `apps/web/src/timeline/derive.ts` recently had to treat `activeTurnId` as authoritative over turn status to prevent `Working` / `Worked` flicker.
- `README.md` already says normal `/v1/events` replay is operational-only and selected timeline history comes from snapshots, but current implementation still needs persisted timeline cursor events and selected/global stream fallback logic.
- `AGENTS.md` already says shared state belongs in gateway or app-server and snapshots/SSE need a gateway-owned source of truth, but it does not yet prohibit reintroducing independent lifecycle derivation in frontend or persisted gateway transcript reconstruction.

## Target Architecture

App-server remains durable transcript owner:

- Completed thread/turn/item/message history comes from app-server `thread/read`, `thread/resume`, and `thread/turns/list`.
- Gateway does not persist transcript rows, projection rows, raw notification replay for timeline reconstruction, or durable active turn ids as routing truth.

Gateway owns one browser-facing `ThreadView` reducer:

- A renamed module such as `apps/gateway/src/thread_view.rs` replaces the current `thread_session_view` terminology.
- It accepts app-server snapshots/resume results and live app-server notifications.
- It emits a single DTO family:
  - `ThreadViewSnapshot`
  - `ThreadViewPatch`
  - `ThreadViewItem`
  - `ThreadViewTurn`
  - pending request summaries
  - monotonic `viewRevision`
- It owns `activeTurnId`, `liveState`, display order, item identity, provisional gateway-owned pending rows, and pending approval/user-input visibility.
- It never treats `item/completed` as `turn/completed`.

Web becomes a thin projection:

- Select thread: fetch `ThreadViewSnapshot`, then subscribe to `ThreadViewPatch`.
- Reconnect/lag: refetch snapshot.
- Apply live update: ignore any patch with `viewRevision <= current.viewRevision`; upsert/replace gateway rows by stable ids.
- Composer route decisions call gateway commands; React does not decide steer/start/queue from local active-turn inference.
- Work rows render from gateway-provided turn state and `activeTurnId`, not raw item status.

## Guardrails

### Code Guardrails

- Introduce gateway module-level invariants in `apps/gateway/src/thread_view.rs`:
  - only `turn/started`, `turn/completed`, app-server snapshot turn status, or explicit app-server thread status may change `activeTurnId`;
  - `item/started` and `item/completed` may update item status but must not complete the turn;
  - a `ThreadViewPatch` must carry one `viewRevision`, and snapshots/patches are comparable with the same field;
  - app-server item ids replace provisional ids; both may not remain visible for the same turn/item;
  - gateway restart rebuilds visible transcript from app-server, not from gateway raw events.
- Add a static guard test or script, for example `apps/gateway/tests/no_partial_timeline_truths.rs` or a focused shell check in CI, that fails if production code reintroduces:
  - `timeline.item_delta` as a frontend visible timeline event,
  - `timeline.snapshot_required` as the normal selected-thread recovery mechanism instead of snapshot-on-lag,
  - production reads from `events` for visible timeline history,
  - production routing from persisted `thread_runtime_state.active_turn_id`.
- Add frontend reducer tests that assert the only visible timeline inputs are canonical snapshots/patches plus browser-local draft rows.
- Add backend event tests that assert item completion does not make an active turn idle.
- Add same-user, two-tab tests for missed live patches and queued input drain convergence.
- Keep raw diagnostic events behind debug-only routes or debug UI names so they cannot be imported by visible timeline modules accidentally.

### `AGENTS.md` Guardrails

Update `AGENTS.md` during implementation with a stricter section under Multi-Client State Ownership:

- App-server is the only durable owner of thread, turn, item, and message history.
- Gateway may keep an in-memory browser-facing thread view, but must not persist transcript/projection rows as a second durable history.
- Gateway persistence is allowed for gateway-native coordination only: queues, automations, approvals/server requests, read markers, pins, notifications, project metadata, preview config, skill metadata, and settings not owned by app-server.
- Visible timeline rendering must consume gateway `ThreadViewSnapshot` / `ThreadViewPatch` only. Frontend code must not construct visible rows from raw app-server notification kinds.
- Active-turn routing must come from gateway commands that inspect current gateway/app-server state. Browser-local `activeTurnId` may only affect presentation.
- `item/completed` is item lifecycle only. `turn/completed` or canonical app-server turn state is required to complete a turn.
- Any change touching selected-thread lifecycle must include a two-tab/reconnect test and a guard against stale snapshot or stale patch overwrite.

## Milestones

### 1. Lock The Contract With Failing Tests

Scope: backend lifecycle tests, frontend reducer/hook tests, and static guard tests.

Work:

- Add backend tests in `apps/gateway/src/thread_session_view.rs` or the new `thread_view` module proving:
  - `item/completed` updates an item but leaves active `activeTurnId` running until `turn/completed`;
  - `turn/completed` clears only the matching active turn;
  - app-server snapshots with stale non-terminal turns do not create multiple active turns;
  - a gateway restart rebuilds transcript from app-server turn history rather than gateway raw events.
- Add event-ingest tests in `apps/gateway/src/events.rs` for:
  - streamed deltas followed by item completion while the turn stays active;
  - terminal `turn/completed` producing exactly one canonical idle patch and notification planning;
  - missed selected-thread live events converging through snapshot fetch.
- Add frontend tests in `apps/web/src/timeline/reducer.lifecycle.test.ts`, `apps/web/src/timeline/reducer.snapshot.test.ts`, and `apps/web/src/App.mvp.timeline.test.tsx` proving:
  - raw `timeline.item_delta` is not accepted as a visible lifecycle source after the migration;
  - stale patches cannot change `activeTurnId`;
  - two clients converge when one misses live patches and later refetches.
- Add static guard checks for banned production imports/event kinds.

Exit criteria:

- New tests fail against the current partial-truth implementation before the refactor.
- Test names describe single-source behavior directly, not symptoms like flicker.
- No implementation code has been changed except test scaffolding and guard script wiring.

### 2. Define The Canonical Thread View Contract

Scope: Rust DTOs, OpenAPI, frontend generated types.

Work:

- Define new DTOs in `apps/gateway/src/app_server_api.rs` or a dedicated API module:
  - `ThreadViewSnapshot`
  - `ThreadViewPatch`
  - `ThreadViewItem`
  - `ThreadViewTurn`
  - `ThreadViewPendingRequest`
- Use one field name, `viewRevision`, for snapshots and patches.
- Keep raw app-server `turns` only as debug/raw payload data, not as frontend-visible render input.
- Regenerate OpenAPI and `apps/web/src/api/generated/schema.ts`.
- Update `apps/web/src/api/client.ts` types so frontend code consumes `ThreadViewSnapshot`/`ThreadViewPatch`.

Exit criteria:

- `GET /v1/threads/{threadId}` exposes one canonical view object for rendering.
- SSE selected-thread render events expose only canonical thread view patches.
- Generated frontend types compile without ad hoc duplicate interfaces.

### 3. Replace `thread_session_view` With A Single Gateway Reducer

Scope: `apps/gateway/src/thread_session_view.rs`, new `thread_view.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/routes/threads.rs`.

Work:

- Rename and reshape `thread_session_view` into `thread_view` so ownership is explicit.
- Normalize app-server snapshots and live notifications through one reducer.
- Remove text-match and base/live merge heuristics from the reducer where stable ids are available.
- Store only in-memory active/provisional state:
  - active turn id,
  - in-flight item buffers,
  - pending request summaries,
  - provisional gateway-owned submitted user rows,
  - last `viewRevision`.
- Ensure completed app-server snapshots replace matching provisional/live rows.
- Make `apply_thread_detail_response_state` call the reducer and return its canonical snapshot.

Exit criteria:

- Backend unit tests can produce the same `ThreadViewSnapshot` from app-server full history and from live notification reduction after reconciliation.
- No durable gateway table is read for visible transcript rows.
- `rg thread_session_view` either finds only migration notes/tests or the renamed module no longer exists.

### 4. Simplify Gateway Events And Replay

Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/routes/events.rs`, `apps/gateway/src/store.rs`, `README.md`.

Work:

- Emit selected-thread live updates as `thread_view.patch` or a similarly explicit canonical event, not `timeline.projection_patch`.
- Remove `timeline.item_delta`, `timeline.snapshot`, and `timeline.snapshot_required` from the visible selected-thread stream.
- Keep operational/global events for approvals, queue rows, thread metadata, read markers, warnings, account rate limits, MCP/config, skills, and notifications.
- Move raw app-server notification visibility to debug-only replay if retained at all.
- Make reconnect behavior simple:
  - if the selected stream reconnects or reports lag, frontend refetches `GET /v1/threads/{id}`;
  - patches older than `viewRevision` are ignored;
  - no raw event replay reconstructs visible history.
- Narrow or remove durable `thread_runtime_state` routing:
  - queue drain checks loaded gateway reducer state first;
  - if not loaded, asks app-server current thread state;
  - stale persisted active turn id cannot steer or block queue drain.

Exit criteria:

- `apps/web/src/events/stream.ts` no longer lists raw timeline render events except the canonical patch event.
- `README.md` describes `/v1/events` as operational plus canonical thread view patch streaming, not timeline replay.
- Backend tests prove queue drain does not route from stale durable `thread_runtime_state.active_turn_id`.

### 5. Make Web Timeline A Thin Renderer

Scope: `apps/web/src/timeline/reducer.ts`, `state.ts`, `batch.ts`, selected/read-only timeline hooks, `App.tsx`, thread event helpers.

Work:

- Replace the reducer with small operations:
  - apply canonical snapshot,
  - apply canonical patch by `viewRevision`,
  - preserve browser-local draft/unsent attachment previews only,
  - append debug rows only when debug mode explicitly asks for them.
- Delete or greatly shrink:
  - `applyTimelineItemDelta`,
  - event `seq` vs `viewRevision` reconciliation,
  - ignored projection cursor logic,
  - visible row construction from raw event envelopes,
  - selected/global fallback lifecycle patching,
  - missing-item removal based on current active turn heuristics.
- Make `useSelectedThreadTimeline.ts`:
  - fetch snapshot,
  - connect stream with `viewRevision`,
  - apply canonical patches,
  - refetch snapshot on reconnect/lag.
- Make `useReadonlyThreadTimeline.ts` use the same canonical logic for subagent/read-only views.
- Keep timeline presentation modules (`presentation.ts`, `derive.ts`, `renderers.tsx`) focused on rendering canonical items, not deciding lifecycle ownership.

Exit criteria:

- Frontend timeline correctness no longer depends on raw `EventEnvelope.kind` values for app-server item/turn lifecycle.
- `activeSelectedTurnId` comes from the canonical snapshot/patch state only.
- Focused frontend tests and `npm run build` pass.

### 6. Queue, Approval, And Automation Integration

Scope: `apps/gateway/src/queue.rs`, `apps/gateway/src/routes/turns.rs`, approval ingestion, automation scheduler, frontend composer tests.

Work:

- Keep queue persistence as gateway-owned coordination state.
- Route active submit/steer decisions through a gateway command that consults:
  - loaded `ThreadView` active state when present,
  - app-server current thread state when absent,
  - never browser-local state,
  - never stale persisted active turn id.
- Represent pending committed user input as gateway-owned provisional rows in `ThreadView` until app-server materializes the real user item.
- Keep approval and tool user-input requests in gateway persistence, then expose them through the canonical view pending request summaries.
- Ensure automations enqueue rows and let the queue drainer use the same authoritative routing path.

Exit criteria:

- Existing queue API behavior remains visible across tabs.
- Two-tab tests cover queued input created in one tab while another tab observes active/idle transitions.
- Approval/user-input request visibility survives reconnect without frontend reconstructing it from raw event history.

### 7. Documentation And Future-Drift Guardrails

Scope: `AGENTS.md`, `README.md`, plan index, and test/guard documentation.

Work:

- Add the `AGENTS.md` guardrails listed above.
- Update `README.md` route descriptions for canonical thread view snapshots and patches.
- Add comments in `thread_view.rs`, selected timeline hooks, and frontend reducer explaining the ownership rule:
  - app-server durable history,
  - gateway canonical live projection,
  - frontend render-only.
- Add static guard check documentation near the test or script that enforces banned raw timeline imports.
- Update `plans/index.md` status as the implementation starts/completes.

Exit criteria:

- New contributors and agents are explicitly told not to reintroduce gateway durable transcript state or frontend raw-event lifecycle reconstruction.
- Documentation matches actual route and event names.
- Guard tests fail with an actionable message if someone imports or subscribes to banned raw timeline events.

## Verification

Backend:

- `cargo fmt`
- `cargo test -p kodex-gateway thread_view`
- `cargo test -p kodex-gateway events`
- `cargo test -p kodex-gateway queue`
- `cargo test`

Frontend:

- `cd apps/web && npm test -- --run src/timeline/reducer.lifecycle.test.ts src/timeline/reducer.snapshot.test.ts src/timeline/derive.test.ts src/App.mvp.timeline.test.tsx src/App.mvp.composer-input.test.tsx`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`

Contract/generated:

- Start gateway, inspect `GET /openapi.json`.
- `cd apps/web && npm run generate:api` after DTO changes.
- Verify `apps/web/src/api/generated/schema.ts` is updated.

Browser validation:

- Use `$agent-browser` against `http://127.0.0.1:8787`.
- Desktop selected thread:
  - start a long tool-heavy turn,
  - confirm only one running work indicator,
  - no `Working` / `Worked` flicker during item completion bursts,
  - stop/send flips only on turn lifecycle.
- Two browser contexts:
  - one misses/reconnects during active turn,
  - both converge without reload,
  - queued message created in one context drains after the current turn and appears in both.
- Mobile/narrow shape:
  - composer stop/send state follows canonical active turn state,
  - queued rows remain visible and actionable.

Static guard:

- Run the guard script/test that rejects banned raw timeline lifecycle event consumption in visible timeline code.

## Risks And Open Questions

- App-server live fanout limitations may still require gateway live fanout. That is acceptable, but the gateway fanout must be from canonical `ThreadView`, not raw notification replay.
- If app-server snapshots can omit currently active in-flight items after reconnect, gateway in-memory rows must cover loaded sessions; after gateway restart, the thread should rebuild from app-server resume/read state and may lose only truly ephemeral in-flight text that app-server did not persist.
- Some routes currently use `thread_runtime_state` for queue recovery. The replacement must preserve queue drain correctness after gateway restart without routing from stale active turn ids.
- Raw debug event replay may remain useful locally. It must stay diagnostic-only and must not be imported by timeline rendering or command routing code.
