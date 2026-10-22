# Side Chat Panes Plan

## Status

Complete.

## Goal

Add one transient side chat per ordinary Kodex thread. A side chat is an app-server ephemeral fork presented through the existing workspace pane system, backed by the existing gateway-owned canonical thread projection, and destroyed globally when any client closes it.

The user-facing tab title is `> {current parent Kodex title}` with the accessible tooltip `Side chat for “{parent title}”`. The side chat inherits the parent thread's execution context and capabilities but does not appear in durable navigation, notification, read-state, or goal workflows.

## Product Contract

- An ordinary existing thread exposes `Open side chat` in the existing visible thread-actions `…` menu in the pane header.
- Draft threads and side threads do not expose the action. Nested side chats are out of scope.
- There is at most one live side thread per parent across the gateway, all browser tabs, and future gateway clients.
- Opening when no side thread exists creates an app-server fork with `ephemeral: true` and `excludeTurns: true`.
- Opening when one already exists focuses its pane in the current workspace or opens another pane showing the same child. It must not fork again.
- The pane uses ordinary placement rules relative to its source pane and otherwise behaves like an existing-thread pane.
- A side chat may open while the parent is running. App-server owns the fork snapshot semantics; the parent is not interrupted.
- The visible side timeline starts empty. The model inherits the parent's context, but inherited parent transcript rows are not rendered in the side pane.
- The side chat inherits the parent's workspace, model, permissions, sandbox and tools. It may modify files when those inherited capabilities permit it.
- Side threads do not have sidebar rows, pins, archives, rename controls, goals, read receipts, unread badges, per-thread notification settings, or push notifications.
- Closing uses the ordinary tab close affordance with no confirmation. Closing any pane for the side thread closes every view of that side thread across clients.
- Close removes the UI immediately, best-effort interrupts an active side turn, calls native `thread/unsubscribe`, clears gateway side-thread state, and publishes authoritative closure to other clients.
- A browser reload may restore the pane while the same gateway/app-server process remains alive. After a gateway/app-server restart, the ephemeral child is irrecoverable; a stale pane is removed with a brief `Side chat expired` notice.
- Unexpected browser disappearance does not attempt unload or introduce pane leases. The side thread remains until explicitly closed or until the gateway/app-server restarts.

## Verified Native Contract

The checked-in contract and isolated `codex-cli 0.160.0` probes establish the following behavior:

- `thread/fork` accepts `ephemeral: true`; paginated ephemeral forks require `excludeTurns: true`.
- The fork response is the authoritative creation response. It contains `ephemeral: true`, `forkedFromId`, and initially inherits an explicitly assigned parent `name`.
- A later `thread/read` of the loaded ephemeral child does not reliably retain the inherited `name` or `forkedFromId`.
- `thread/resume` rejects the ephemeral child with `no rollout found` even while the child remains loaded.
- `thread/turns/list` rejects ephemeral children.
- `thread/read` with `includeTurns: true` rejects ephemeral children.
- `thread/unsubscribe` is connection-scoped. Kodex has one gateway-to-app-server connection, so native unsubscribe is globally destructive for every browser client using that gateway.
- Successful unsubscribe removes the subscription immediately but app-server keeps an idle thread loaded for a 30-minute unload grace period. The pinned protocol has no immediate `thread/unload` RPC; Kodex clears its own relationship/projection immediately and accepts native delayed reclamation.

Consequences:

- Do not reuse the generic durable fork route, which currently publishes a catalog change.
- Do not infer side-thread identity from later native reads. Retain the parent/child relationship in gateway memory from the accepted fork response.
- Do not call native `thread/resume`, `thread/turns/list`, or `thread/read(includeTurns: true)` when a side pane attaches.
- Reuse `ThreadViewStore` for the visible side transcript. Initialize it at fork creation and fold subsequent native events into it exactly as for normal threads.
- The side projection is intentionally process-local. Losing it at gateway restart is the same lifetime boundary as losing the ephemeral native thread.

## Ownership Model

### App-server

- Owns the live ephemeral fork, inherited model context, turns, tools, approvals, execution, interruption and grace-delayed unload.
- Emits the normal thread/turn/item lifecycle while the gateway connection remains subscribed.
- Does not provide durable replay or recovery for the side thread.

### Gateway

- Atomically owns the one-parent-to-one-child side-thread relationship.
- Retains enough creation metadata to identify the side thread without later native lineage reads.
- Owns browser-facing canonical side timeline state through the existing `ThreadViewStore`.
- Serves current side snapshots without native resume/history hydration.
- Prevents ephemeral activity from entering catalog, read-state, unread, badge, notification and durable metadata paths.
- Owns global close, native cleanup, stale-pane responses and cross-client closure events.

### Browser

- Owns pane layout, focus, cached presentation title, drafts and other per-tab UI state.
- Marks a normal existing-thread target with its authoritative parent relationship.
- Renders the title from the parent thread's current Kodex display title.
- Never counts panes or decides whether native unsubscribe is safe.

## Data Model

Add a process-local `SideThreadRegistry` to `AppState` with:

- an active `parent_thread_id -> SideThreadEntry` mapping;
- a reverse `side_thread_id -> parent_thread_id` mapping;
- per-parent creation/close serialization so concurrent browser requests cannot create two forks;
- the accepted fork metadata needed to serve a side snapshot without native history hydration;
- closing-state handling only if required to suppress late native events between interrupt/unsubscribe and `thread/closed`.

`SideThreadEntry` should minimally retain the parent id, child id and accepted child summary/creation metadata. It must not become a durable database table, transcript store, browser-pane registry, lease system or subscriber counter.

Extend the frontend existing-thread target rather than adding a separate pane kind:

```ts
type ExistingThreadPaneTarget = {
  mode: "existing";
  threadId: string;
  sideThreadOf?: string;
};
```

Central helpers should identify side panes and their parent; do not scatter optional-field checks through workspace and thread code.

## Public API Contract

Add typed Rust DTOs and OpenAPI routes for the singleton side-thread resource beneath a parent thread:

- `POST /v1/threads/{parentThreadId}/side-thread`
  - Atomically create or return the live side thread.
  - Return the parent identity/current display metadata, child identity/metadata, canonical empty-or-current side snapshot, and whether the child was reused if that is useful to callers.
- `GET /v1/threads/{parentThreadId}/side-thread`
  - Return the current registered child and canonical gateway snapshot without native resume/history calls.
  - Return a typed absent/expired result when no matching live child exists.
- `DELETE /v1/threads/{parentThreadId}/side-thread`
  - Idempotently close the registered child, best-effort interrupt active work, unsubscribe natively, clear the active mapping/projection and broadcast closure.

The browser retains both parent and child ids and must reject a restored pane if the returned registered child no longer matches its stored child id. A stale restored pane must never silently attach to a newly created replacement side chat.

Regenerate `/openapi.json` and `apps/web/src/api/generated/schema.ts`; do not hand-write duplicate frontend DTOs.

## Gateway Lifecycle

### Create or reuse

1. Acquire the parent-scoped side-thread operation guard.
2. Return the existing registered entry when present and still live.
3. Reject a parent that is itself a side thread.
4. Call native `thread/fork` with the parent id, `ephemeral: true`, `excludeTurns: true`, and no unrelated setting overrides.
5. Validate the returned thread is ephemeral and identifies the requested parent when the response exposes lineage.
6. Register the parent/child relationship before exposing it to browsers.
7. Initialize the child's canonical `ThreadViewStore` snapshot as an empty visible history at a captured gateway projection revision.
8. Do not publish `catalog_changed`, insert durable read/notification state, or list the child in projects/chats.

Keep native RPCs outside broad projection write exclusion, while preserving the existing revision/cursor ordering rules when initializing the child view.

### Live execution and projection

- Route side composer input to the native loaded child without a native resume step.
- Reuse normal canonical turn/item ingestion, approvals and `thread_view.patch` / `thread_view.item_delta` delivery.
- Audit queue, start-or-steer, settings, attachment, Stop and approval paths against ephemeral native support. Prefer native semantics and remove or disable only unsupported durable controls; do not create a parallel queue or settings store.
- Keep the side timeline scoped to side-authored turns. Parent history remains model context, not visible projection rows.
- Serve reloads and additional browser clients from the gateway's current side projection.
- Suppress push, unread, seen and sidebar/catalog effects for registered side child ids before those durable paths mutate state.

### Close

1. Remove the active parent mapping atomically so a later open creates a fresh fork.
2. Publish one canonical `side_thread.closed` event containing parent id, child id and a reason.
3. Best-effort interrupt an active child turn through gateway-owned current-state routing.
4. Call native `thread/unsubscribe` even when interrupt reports a terminal/no-active result. Do not wait for or emulate app-server's 30-minute unload grace period.
5. Remove the child's canonical projection and transient side metadata.
6. Treat repeated close, native `notLoaded` and native `notSubscribed` as successful convergence.
7. Handle a later native `thread/closed` idempotently and suppress any late closed-child activity from recreating browser-visible state.

Native `thread/closed` for a registered child must also clear the registry and broadcast side closure if an explicit browser close did not already do so. App-server process replacement naturally starts with an empty registry.

## Frontend UX

### Opening

- Add `Open side chat` to `ThreadActionsMenu` for ordinary materialized threads.
- Disable repeat submission while the create-or-get request is pending.
- On success, focus an existing local pane for the returned child or append a pane through the existing `openThreadPane` placement rules with the parent pane as the placement source.
- Store `threadId` plus `sideThreadOf`; do not rename the native child to add `>`.

### Title and tooltip

- Render `> ${threadDisplayTitle(parent)}` at the tab presentation boundary.
- Use `> Side chat` only while parent metadata is unavailable.
- Render the accessible tooltip `Side chat for “${threadDisplayTitle(parent)}”`.
- Keep the parent id as the source of truth. Cache a presentation title only to avoid blank/loading flicker.
- Reuse existing parent summary/title invalidation so native preview changes and manual parent renames update every side pane.
- Prevent the child-focused `useThreadPaneTitle` flow from overwriting the parent-derived side title.

### Pane behavior

- Reuse `ThreadPane`, composer, timeline, approvals, file rendering and normal responsive pane behavior.
- A side target loads through the side-thread snapshot route, not ordinary durable `attachThread`.
- Keep SSE subscription by child thread id so existing live routing reaches the pane.
- Hide nested-side, duplicate, pin, archive, rename, notification and goal controls for side panes. Retain only actions that are meaningful for a live ephemeral child, such as copying its thread id.
- Do not call `useThreadReadState`, mark-seen routes, badge refresh or notification-setting mutations for side panes.
- Keep inherited model/effort/service-tier/permission presentation and sparse live updates only where the pinned native contract supports them.
- If a generated app surface is opened from a side chat, ensure global side close removes any pane that still requires that child thread. Independent terminals and files remain open.

### Close and convergence

- The standard Dockview/tab close removes the local side pane immediately and asynchronously calls the side delete route.
- Remote `side_thread.closed` removes every pane referencing the child, including duplicate views in another tab, without issuing another cleanup request.
- Cleanup failure does not resurrect a removed pane. Surface a non-blocking error and allow native/gateway restart cleanup.
- Persist the side marker with ordinary workspace pane state. On browser reload, validate the stored parent/child pair against the gateway side resource.
- On an absent/mismatched entry, remove the stale pane, preserve unrelated panes/drafts, choose the normal next active pane and show `Side chat expired`.

## Milestones

### M1 — Native adapter, registry and typed API

Start with failing backend tests for the shared lifecycle contract.

- Add typed native `thread/unsubscribe` support and any focused helpers needed for ephemeral fork creation.
- Add `SideThreadRegistry` with atomic create-or-get behavior and reverse lookup.
- Implement typed `POST`, `GET` and `DELETE` side-thread routes.
- Fork with exactly the supported ephemeral payload and avoid the generic fork route's catalog mutation.
- Initialize/remove the existing canonical projection at side lifecycle boundaries.
- Add OpenAPI DTOs/routes and regenerate frontend API types.

Exit:

- Concurrent create requests make one native fork and return one child.
- The fork request contains `ephemeral: true` and `excludeTurns: true`.
- Side creation produces no catalog, read-state or notification rows/events.
- Side GET returns a gateway snapshot without `thread/resume`, `thread/turns/list` or `includeTurns` reads.
- Repeated delete converges successfully and calls native unsubscribe at most once for the active entry.
- Focused backend tests, `cargo fmt`, generated contract checks and relevant schema tests pass.

### M2 — Projection, input and lifecycle convergence

Start with failing projection/event and two-client contract tests.

- Seed an empty canonical child view at fork acceptance.
- Verify side turn start/steer, Stop, approvals, attachments, settings and queue behavior against pinned native support; use native behavior rather than durable substitutes.
- Ensure all normal live child events flow through canonical thread-view patches/deltas.
- Exclude side children from summary/catalog, read/unread, badge and push pipelines.
- Normalize explicit close, native `thread/closed` and app-server replacement into one idempotent side closure outcome.
- Add `side_thread.closed` to browser-visible lifecycle guardrails and existing documentation.
- Ensure late close/unload events cannot recreate a removed side projection.

Exit:

- A side turn renders through canonical thread-view events without raw timeline rendering.
- A second simulated client obtains the same snapshot and child id without another fork or native resume.
- Closing in one client publishes one closure and makes every client converge.
- Active-turn close interrupts best-effort and still unsubscribes.
- Native close/app-server loss clears the relationship without durable residue.
- Focused event, projection, input, approval and notification tests pass.

### M3 — Pane UX and frontend behavior

Start with the closest domain/component tests.

- Extend existing-thread pane targets with `sideThreadOf` and central side-pane helpers.
- Add generated API client wrappers and workspace `openSideThreadPane` orchestration.
- Add the ordinary-thread menu action and pending state.
- Render the parent-derived `>` tab title and accessible tooltip with live parent-title updates.
- Load side panes from gateway snapshots while reusing the ordinary timeline/composer renderer.
- Remove unsupported durable actions and side read/notification/goal effects.
- Integrate immediate local close, backend cleanup and remote close without cleanup loops.
- Restore live side panes after browser reload and remove expired/mismatched panes safely.

Exit:

- Component tests cover menu eligibility, one-local-pane focus, ordinary placement, title fallback/update and tooltip.
- Side pane tests prove no rename/pin/archive/notification/goal/seen calls occur.
- Close tests prove local immediacy, one cleanup request and remote multi-pane removal.
- Reload tests distinguish a live gateway side child from an expired child.
- Existing draft, ordinary-thread, Dockview and responsive pane tests remain green.

### M4 — Real-runtime and browser validation

- Add or extend an isolated pinned-runtime proof for ephemeral fork, lack of resume/history hydration, inherited context, direct live turn use and unsubscribe acceptance without touching production state. The child remains in native `thread/loaded/list` during the documented 30-minute grace period.
- Use Playwright's bundled Chromium and `$agent-browser` for the browser-observable flow.
- Validate desktop fine-pointer, narrow fine-pointer and narrow touch presentation through existing shared pane rules.
- Validate same-user two-tab create-or-get, live updates, parent rename, global close and missed-event recovery.
- Validate browser reload while the gateway remains alive and stale-pane cleanup after a disposable gateway/app-server restart.
- Confirm no console errors, sidebar insertion, badge change or push/read-state request occurs.
- Complete independent review, apply findings, and rerun affected validation.

Exit:

- Relevant backend and frontend focused suites pass.
- `cargo test` passes.
- `cd apps/web && npm test`, `npm run build` and focused Playwright flows pass.
- `./tools/trim-backend.sh` and `./tools/trim-frontend.sh` pass or only report documented unrelated findings.
- Generated OpenAPI/frontend types are current.
- The plan and `plans/index.md` record final evidence before status becomes Complete.

## Required Test Shapes

### Backend

- Two concurrent opens for one parent create one child.
- Two different parents create independent children.
- A side child cannot become a parent for another side child.
- An existing mapping is reused without native fork.
- Side creation and live events never emit sidebar/catalog membership.
- Side snapshot reads never invoke native durable hydration methods.
- Explicit close during idle and active states converges through unsubscribe.
- Repeated close and a racing native `thread/closed` are idempotent.
- Side completion does not mutate read state, unread badge or push eligibility.
- Gateway restart begins with no side mapping and cannot claim a stale child.

### Frontend

- The parent `…` menu exposes `Open side chat`; draft and side panes do not.
- Open focuses an existing local child or appends it with source-pane placement.
- Tabs render `> {parent title}` and the accessible parent tooltip.
- Parent preview/name changes update the side title; child metadata cannot overwrite it.
- The visible timeline contains only side turns.
- Side panes preserve normal composer drafts, attachments, approvals and responsive behavior.
- Unsupported durable controls and read/notification requests are absent.
- Closing one duplicate view removes all local/remote views and sends one cleanup request.
- A live reload restores the side pane; an expired reload removes only the stale pane and shows the notice.

### Browser / two-tab

- Tab A and Tab B concurrently open the same parent's side chat and receive one child id.
- A turn started in one tab streams canonically in the other.
- Renaming the parent updates both side tab titles.
- Closing from either tab removes both views without reload.
- A client that misses the close event converges through the side resource snapshot rather than retaining or recreating the child.

## Non-Goals

- More than one simultaneous side chat per parent.
- Nested side chats.
- Durable side-chat history, sidebar entries, search, pinning, archive or reopen after gateway restart.
- Selected-text `Ask in side chat`, `/side <prompt>`, automatic initial prompts or fork-at-selected-turn UX.
- Browser pane reference counting, leases, heartbeat cleanup or unload on `beforeunload`.
- A second gateway transcript database, event-replay transcript, side-specific queue store or settings store.
- Changes to normal durable-thread attach/resume semantics.
- Public-internet deployment claims. Kodex remains a local/trusted-VPN application.
- Deployment as part of this plan unless separately requested.

## Verification Commands

- `cargo fmt`
- Focused backend route, app-server adapter, projection, event, notification and lifecycle tests.
- `cargo test`
- `cd apps/web && npm run generate:api`
- Focused frontend workspace, thread-pane, composer, events and API tests.
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- Focused Playwright two-tab, reload and responsive-pane flows using bundled Chromium.
- `$agent-browser` manual browser-observable validation where required by repository guidance.
- `./tools/trim-backend.sh`
- `./tools/trim-frontend.sh`
- `du -sh target 2>/dev/null` before any push; run `cargo clean` if it exceeds 6 GB.

## Review Checklist

- The gateway, not React, enforces one child per parent.
- Native ephemeral behavior is used directly; no persistence or compatibility layer was introduced.
- Browser transcript rendering uses only canonical thread-view snapshots/patches/deltas.
- No side path calls native resume or unsupported history APIs.
- No side activity enters catalog, read/unread, badge, notification or goal state.
- Close is globally destructive, idempotent and correct with two tabs.
- Parent-derived titles remain authoritative after rename, reload and child metadata updates.
- Stale panes cannot attach to a replacement child.
- Existing ordinary thread, queue, approval, responsive pane and Dockview behavior remains intact.
- Generated contracts, tests, docs and trim checks are current.

## Completion Evidence

- Eight focused gateway lifecycle tests pass, including concurrent singleton creation, exact ephemeral fork parameters, current parent-summary refresh without side history hydration, nested rejection, Stop routing, read/push exclusion, active close and disconnect/native-close convergence.
- The isolated pinned `codex-cli 0.160.0` proof passes against disposable state. It materializes a parent rollout, verifies the side model request inherits parent request/response context while the visible side snapshot begins empty, submits through `queueIfPending`, closes through unsubscribe and observes the native 30-minute loaded-session grace contract.
- Focused frontend tests pass (93 tests across thread pane, workspace, Dockview and SSE coverage), including restored/mismatched panes, parent-title updates, accessible tooltip, menu eligibility and cross-client closure.
- The complete frontend suite passes: 174 files, 1,343 tests passed and one skipped. The production build and generated OpenAPI TypeScript contract pass.
- Focused Chromium coverage passes three flows: desktop two-tab singleton/reload/global close, narrow fine-pointer open/close and narrow touch open/close. No fixture console or unexpected-request errors remain.
- `cargo test`, `cargo fmt --check`, `./tools/trim-backend.sh` and `./tools/trim-frontend.sh` pass. The full Rust gate also corrected a stale test-only assertion that still required the intentionally optional standalone `spawn_thread.projectId` field.
- A final self-review checked gateway ownership, native 0.160 schema behavior, canonical projection-only rendering, no durable sidebar/read/push/goal effects, late-event/import fencing, current parent-derived titles, stale replacement safety and same-user two-tab convergence. A review subagent was not permitted for this task, so the repository's documented fallback review was used.

## References

- [Plans index](index.md)
- [Native app-server redesign](native-app-server-redesign.md)
- [Responsive UI contract](responsive-ui-contract.md)
- [Contributor rules](../AGENTS.md)
- [App-server `ThreadForkParams`](../apps/gateway/app-server-schema/0.160.0/json/v2/ThreadForkParams.json)
- [App-server `ThreadUnsubscribeParams`](../apps/gateway/app-server-schema/0.160.0/json/v2/ThreadUnsubscribeParams.json)
- [Gateway canonical thread projection](../apps/gateway/src/thread_view.rs)
- [Gateway thread routes](../apps/gateway/src/routes/threads.rs)
- [Workspace pane types](../apps/web/src/workspace/paneTypes.ts)
- [Thread pane](../apps/web/src/panes/thread/ThreadPane.tsx)
