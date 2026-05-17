# TUI-Aligned Thread Timeline Simplification Plan

## Status

Active.

## Context

Kodex currently has redundant transcript-adjacent state across app-server history, gateway SQLite events, durable timeline projection rows, thread runtime rows, frontend timeline reducer state, optimistic rows, queued-input projection rows, and approval rows. The observed failure mode is out-of-order rendering and duplicate messages when snapshots, live SSE, optimistic rows, and projection overlays race.

The target change is a hard simplification rather than a compatibility-preserving migration:

- Treat upstream Codex TUI behavior as the source of truth for thread/message interaction.
- Keep app-server as the only durable owner of thread, turn, item, and message history.
- Move TUI-like session/event reduction into the gateway so web clients are thin renderers.
- Remove durable gateway transcript/projection persistence that requires synchronizing a second history source.

The upstream TUI model to preserve:

- New thread: `thread/start`, then first user input uses `turn/start`; live notifications feed the same renderer-facing model.
- Resume idle/completed thread: `thread/resume` returns current turns; history is normalized into the renderer-facing model; next user input uses `turn/start`.
- Resume active thread: `thread/resume` returns turns including any `inProgress` turn; the client restores the active turn id from the latest in-progress turn, then continues live notifications.
- Active submit: if an active turn id exists, TUI tries `turn/steer`; if the app-server reports no active turn, clear the cached active id and fall back to `turn/start`.
- Pending approval/user-input requests are part of the active session state and must be replayable to the visible client when still pending.

## Current State

Code-established facts:

- `apps/gateway/src/routes/threads.rs::create_thread` and `create_chat_thread` call app-server `thread/start`, while web composer later calls `turn/start` from `apps/web/src/composer/useComposerOrchestration.ts`.
- `apps/gateway/src/routes/threads.rs::resume_thread` calls app-server `thread/resume`, but web rendering primarily comes from `GET /v1/threads/{threadId}`.
- `apps/gateway/src/app_server_api.rs::thread_read_full_history` composes `thread/read includeTurns:false` with paged `thread/turns/list itemsView:"full"` for selected-thread snapshots.
- `apps/gateway/src/app_server_api.rs::ThreadTimelineSnapshot::from_turns` derives `active_turn_id` from the latest non-terminal turn in a snapshot.
- `apps/gateway/src/timeline_projection.rs` and `apps/gateway/src/store.rs` currently persist `timeline_projection_items`, then merge those rows with app-server snapshots.
- `apps/gateway/src/events.rs::ingest_inbound` persists raw `codex.notification` events, emits normalized timeline events, updates durable `thread_runtime_state`, and broadcasts projection patches.
- `apps/gateway/src/queue.rs` uses persisted `thread_runtime_state` and can reconcile active turn state from app-server via `thread_read`.
- `apps/web/src/timeline/reducer.ts` still contains snapshot/patch/optimistic/delta merge logic, active turn inference, projection revision handling, and duplicate prevention heuristics.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts` already follows a snapshot-then-stream shape, but the stream still carries multiple timeline event kinds and the reducer still performs meaningful reconciliation.
- `apps/gateway/src/events.rs` persists supported app-server server requests as approval rows; this includes approval-like requests and `item/tool/requestUserInput`.

Constraints and settled decisions:

- `AGENTS.md` requires app-server schemas and upstream README as the app-server wire contract, and TUI as the real-client sequencing reference.
- Shared thread/session state that must converge across tabs belongs in the gateway or app-server, not React state.
- Frontend API types must come from generated OpenAPI artifacts.
- Shared thread/session lifecycle changes need same-user, two-tab test coverage.
- The user explicitly accepts drastic simplification without compatibility layers and prefers correctness over preserving transitional APIs.
- The user explicitly prefers no extra durable thread/message persistence outside app-server.

## Target Architecture

App-server is the only durable transcript source:

- No durable gateway table stores transcript/timeline/message rows.
- Gateway may keep in-memory per-loaded-thread session state equivalent to TUI's thread event store.
- Gateway persists only non-transcript coordination state:
  - pending approval/user-input request records needed for browser decisions,
  - queued composer inputs and automation scheduling state,
  - read markers/unread counters,
  - pins, project ordering, UI metadata,
  - thread option fallbacks only where app-server does not own the setting or automations explicitly need a stored policy.

Gateway becomes the canonical client reducer:

- On `thread/start`, `thread/resume`, `thread/read`, or `thread/turns/list`, gateway normalizes app-server turns into one in-memory `ThreadSessionView`.
- On live app-server notifications, gateway applies them to that same in-memory view.
- The view owns active turn id, item ordering, pending request state, and provisional user rows.
- Web gets one canonical snapshot and monotonic patches from the gateway.
- Web renders by gateway-provided display order and ids; it does not interpret app-server raw payloads for merge correctness.

Web becomes thin:

- Select thread: fetch canonical gateway snapshot, then subscribe to gateway patches.
- Apply patch: replace/upsert gateway-owned rows by stable id and revision.
- Submit while active: ask gateway to enqueue or steer according to gateway-owned active turn state; do not infer command routing from React-only state.
- Render approvals/user-input requests from gateway-owned pending request records.

## Non-Goals

- Do not add a new durable transcript cache in gateway SQLite.
- Do not repair app-server history by merging old gateway event rows.
- Do not preserve the current frontend timeline event API if a thinner snapshot/patch API is clearer.
- Do not keep `timeline_projection_items` or durable `thread_runtime_state` as compatibility surfaces.
- Do not redesign timeline visual presentation, composer chrome, project previews, automations UI, or MCP management.
- Do not make the gateway safe for public internet exposure.

## Milestones

### 1. Lock TUI Parity With Failing Contract Tests

Scope: backend tests in `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/queue.rs`; frontend tests only where they assert thin-client behavior.

Work:

- Add tests for the TUI-derived cases:
  - new thread: `thread/start` then `turn/start`, no duplicate initial user row,
  - resume idle: restored turns produce no active turn id and next submit uses `turn/start`,
  - resume active: latest `inProgress` turn restores active turn id and live notifications append to that turn,
  - active submit race: gateway attempts `turn/steer`, clears stale active id on "no active turn", then starts a new turn when appropriate,
  - waiting on approval/user input: pending request remains visible after client reconnect or tab switch.
- Add a two-tab convergence test shape:
  - tab A observes active live events,
  - tab B opens or reconnects later,
  - tab B converges from gateway/app-server state without relying on tab A's React state.
- Add regression tests for duplicate and out-of-order item prevention using stable `threadId + turnId + itemId` identity and gateway display order.

Exit criteria:

- Tests describe TUI parity and fail against any path that requires durable gateway transcript/projection rows for correctness.
- Tests establish that app-server history plus gateway in-memory live state is sufficient for visible timelines.
- Existing approval and queue tests remain runnable while the new assertions are failing.

### 2. Introduce A Gateway In-Memory Thread Session Reducer

Scope: new gateway module, likely replacing `apps/gateway/src/timeline_projection.rs`; integration in `apps/gateway/src/events.rs`, `apps/gateway/src/routes/threads.rs`, and `apps/gateway/src/routes/turns.rs`.

Work:

- Create a gateway-owned in-memory reducer modeled on TUI's `ThreadEventStore`:
  - session/thread metadata,
  - ordered turns and items,
  - active turn id derived from latest non-terminal turn,
  - buffered live notifications by thread,
  - pending app-server server requests by request id,
  - provisional user input rows until app-server materializes real items.
- Normalize both snapshot turns and live notifications through this reducer.
- Produce renderer-facing DTOs from the reducer:
  - `ThreadViewSnapshot`,
  - `ThreadViewPatch`,
  - `ThreadViewItem`,
  - active turn/live state metadata,
  - pending request summaries where needed.
- Ensure app-server item ids win when app-server materializes an item. Provisional gateway ids must be replaced or removed, not kept as duplicate visible rows.
- Keep the reducer in memory. If the gateway restarts, selected threads rebuild from app-server snapshots and current app-server resume/read state.

Exit criteria:

- Gateway unit tests can build identical renderer-facing state from:
  - `thread/resume` turns plus later notifications,
  - `thread/read`/`thread/turns/list` turns plus later notifications.
- Active turn id comes from reducer state, not frontend inference or durable `thread_runtime_state`.
- No new SQLite transcript table is introduced.

### 3. Make Thread Open/Resume Use The Reducer As The Single Gateway Projection

Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/app_server_api.rs`, app-server command helpers, OpenAPI DTOs.

Work:

- Route `POST /v1/threads/{threadId}/resume` through the reducer:
  - call app-server `thread/resume`,
  - load returned turns if present,
  - or call `thread/turns/list itemsView:"full"` when using metadata-only resume,
  - update in-memory session state,
  - return a canonical gateway thread view or thread summary plus view revision.
- Route `GET /v1/threads/{threadId}` through the same reducer:
  - read app-server metadata/history,
  - rebuild or refresh the in-memory view,
  - return canonical renderer snapshot.
- Route new thread creation through the same session registration path so `thread/start` and later `turn/start` cannot create parallel frontend-only and gateway-only representations.
- Remove response-shape assumptions that require web to merge `ThreadCommandResponse.thread`, `ThreadDetailResponse.turns`, and `ThreadDetailResponse.timeline` independently.
- Regenerate OpenAPI and frontend generated types after DTO changes.

Exit criteria:

- `GET /v1/threads/{id}` and `POST /v1/threads/{id}/resume` expose one canonical renderer snapshot/revision contract.
- Selected-thread snapshot does not read `timeline_projection_items`.
- `ThreadDetailResponse.turns` is either removed from the renderer contract or explicitly debug/raw-only; visible rendering uses gateway canonical items.
- Focused backend route tests pass for create, resume idle, resume active, and not-loaded attach.

### 4. Replace Durable Timeline Projection And Runtime Persistence

Scope: `apps/gateway/src/store.rs`, `apps/gateway/src/timeline_projection.rs`, `apps/gateway/src/events.rs`, `apps/gateway/src/queue.rs`, route tests.

Work:

- Delete or stop using:
  - `timeline_projection_items`,
  - `NewTimelineProjectionItemRecord`,
  - `TimelineProjectionItemRecord`,
  - `record_item_upsert`,
  - `record_item_delta`,
  - durable projection patch construction from SQLite rows.
- Delete or narrow durable `thread_runtime_state`:
  - active turn id belongs to the in-memory reducer and app-server snapshot/resume state,
  - queue draining may ask the reducer first and fall back to app-server `thread/read` or `thread/resume` when the thread is not loaded in gateway memory,
  - no stale durable active turn id can route a command.
- Stop persisting raw transcript-like app-server notifications as normal operational history if they are only useful for reconstructing timeline rows.
  - Keep approval records and supported server requests.
  - Keep warnings, MCP/config events, read markers, queue events, and notification planning where they are not transcript history.
  - If debug raw notification visibility is still useful, make it bounded/in-memory or explicit diagnostic-only, not a renderer dependency.
- Keep existing SQLite tables orphaned if needed for non-disruptive local startup, but remove code paths that read/write them. Since this is a correctness-first hard cut, no compatibility read layer is needed.

Exit criteria:

- `rg` shows no production read/write path for `timeline_projection_items`.
- `rg` shows no production command routing path that depends on durable `thread_runtime_state.active_turn_id`.
- Gateway restart followed by opening a thread rebuilds visible history from app-server without using gateway transcript persistence.
- Queue tests prove active-turn steering is based on current reducer/app-server state.

### 5. Convert Web Timeline To A Thin Renderer

Scope: `apps/web/src/timeline/reducer.ts`, `apps/web/src/timeline/state.ts`, `apps/web/src/timeline/useSelectedThreadTimeline.ts`, `apps/web/src/timeline/useReadonlyThreadTimeline.ts`, `apps/web/src/events/stream.ts`, `apps/web/src/App.tsx`, `apps/web/src/threads/events.ts`.

Work:

- Replace frontend timeline reducer responsibilities with:
  - apply canonical snapshot,
  - apply canonical gateway patch by revision and row id,
  - keep browser-local draft text and unsent attachment previews only.
- Remove frontend merge heuristics tied to app-server raw payload interpretation:
  - text matching between optimistic and app-server items,
  - fractional display order,
  - local active-turn inference from granular event kinds,
  - separate handling for `timeline.item_delta`, `timeline.item_upsert`, `timeline.turn_upsert`, and `timeline.thread_status` as visible row constructors.
- Make selected/read-only thread hooks:
  - fetch gateway snapshot,
  - connect stream with snapshot revision,
  - apply only gateway canonical patches,
  - refetch snapshot on reconnect/lag/`snapshot_required`.
- Keep raw debug events and warnings out of visible message ordering.
- Keep frontend presentation/rendering helpers for app-server item shapes, but only after the gateway has decided item identity, order, status, and active turn state.

Exit criteria:

- Web timeline state no longer needs `projectionRevision` semantics tied to SQLite projection rows; any revision is gateway view revision only.
- Thin-client tests show duplicate prevention comes from stable gateway row ids, not frontend text heuristics.
- Browser-local state is limited to drafts, unsent attachments, focus/scroll, and transient optimistic UI that is not shared across tabs.
- `cd apps/web && npm test -- src/timeline/reducer.snapshot.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/batch.test.ts`
- `cd apps/web && npm run build`

### 6. Rework Composer Active-Turn Routing Around Gateway Authority

Scope: `apps/web/src/composer/useComposerOrchestration.ts`, `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/queue.rs`, `apps/gateway/src/automations.rs`, queue tests, composer tests.

Work:

- Make the gateway own the decision "turn/start vs turn/steer vs queue for later".
- The web app submits user intent to the gateway with the selected thread id and input; it does not choose routing solely from React `activeTurnId`.
- Gateway behavior should mirror TUI:
  - if reducer/app-server says active turn exists, try `turn/steer`,
  - if app-server rejects with no active turn, clear active state and start a new turn if the request was a normal user submit,
  - if active turn is non-steerable, persist/queue the input and report the queue row,
  - for automations, keep existing queue-first policy unless explicitly changed by a separate product decision.
- Keep queued composer rows gateway-owned and durable because they are coordination state, not transcript history.
- Reconcile provisional user rows through the reducer so all connected clients see accepted/pending input consistently.

Exit criteria:

- A stale browser cannot start a new turn while another tab's active turn should receive steer input.
- Queue retry/steer behavior uses current gateway/app-server state, not a stale durable runtime row.
- Same-user two-tab tests cover active submit, stale active id, and non-steerable active turn.

### 7. Preserve Pending Requests Without Treating Them As Transcript History

Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/approvals.rs`, `apps/gateway/src/schema.rs`, `apps/web/src/approvals`, pending request UI/tests.

Work:

- Keep app-server server requests that need browser action as gateway-owned pending request records.
- Continue supporting:
  - command approval,
  - file change approval,
  - permissions approval,
  - MCP elicitation,
  - tool user input.
- Attach pending requests to the in-memory thread view so a resumed/selected active thread can show "waiting for approval/user input" state consistently.
- Keep durable approval/request records only while pending/resolving/resolved for coordination and audit; do not use them as timeline message rows unless app-server also materializes a thread item.
- Surface `waitingOnApproval` and `waitingOnUserInput` from app-server `activeFlags` or pending request state as explicit gateway view state for the web renderer.

Exit criteria:

- Resuming a thread waiting for approval shows the pending approval without requiring raw event replay.
- Resuming a thread waiting for tool/user input shows the pending input UI without requiring frontend raw server-request replay.
- Resolving a pending request updates the gateway view and all connected clients.

### 8. Documentation, Generated Artifacts, And Cleanup

Scope: `README.md`, `AGENTS.md` if workflow rules change, `plans/index.md`, OpenAPI generation, deleted-code cleanup.

Work:

- Document the new ownership rule:
  - app-server durable transcript,
  - gateway in-memory canonical session/timeline reducer,
  - gateway durable coordination state only,
  - web thin renderer.
- Update local API docs/OpenAPI descriptions for thread detail, resume, stream patches, and submit routing.
- Regenerate frontend API types.
- Remove obsolete tests and fixtures that model durable timeline projection or frontend history reconstruction.
- Keep `plans/index.md` status current as implementation starts/completes.

Exit criteria:

- README no longer implies gateway persisted timeline projection is a source of thread history.
- `rg` does not find frontend-visible documentation for old granular timeline event rendering as the canonical path.
- Generated schema files are current.

## Verification

Backend:

- `cargo fmt`
- `cargo test -p kodex-gateway app_server_api`
- `cargo test -p kodex-gateway thread_routes`
- `cargo test -p kodex-gateway timeline`
- `cargo test -p kodex-gateway queue`
- `cargo test -p kodex-gateway approvals`
- Full `cargo test` before completion.

Frontend:

- `cd apps/web && npm test -- src/timeline/reducer.snapshot.test.ts src/timeline/reducer.lifecycle.test.ts src/timeline/batch.test.ts`
- `cd apps/web && npm test -- src/App.mvp.timeline.test.tsx src/App.mvp.composer-input.test.tsx src/App.mvp.approvals-stream.test.tsx`
- `cd apps/web && npm run build`

Browser validation:

- Use `$agent-browser` against the local fullstack app for:
  - new thread first message,
  - resume idle thread,
  - resume active streaming thread,
  - active submit from two tabs,
  - waiting-for-approval resume,
  - rapid thread switch while streaming.

Operational checks:

- Restart gateway, open existing threads, and verify history rebuilds from app-server with no gateway transcript rows.
- Verify queued inputs and pending approvals survive gateway restart because they are coordination state.
- Verify old orphaned projection tables, if present in an existing SQLite DB, are ignored.

## Risks And Open Questions

- App-server may not expose enough pending request state after gateway restart to restore approvals/user-input requests that were pending before restart. If so, keep the existing pending approval/request persistence as coordination state and treat it as the source for browser decisions until app-server adds a replayable pending-request list.
- Active live turn reattach depends on talking to the same app-server process that owns the running turn. If the app-server process is gone, gateway can only rebuild persisted history and continue from app-server's durable state.
- Large active threads may make full snapshot reads expensive. Prefer `thread/resume excludeTurns:true` plus `thread/turns/list itemsView:"full"` pagination where needed, but do not add a gateway durable transcript cache for performance.
- Automations currently use gateway-owned queued input and stored options. This plan keeps that as coordination/scheduling state, not transcript state; changing automation option inheritance is separate product work.
