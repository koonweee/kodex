# Frontend-Owned Workspace Panes Plan

## Status

Complete.

Supersedes [Workspace panes architecture plan](workspace-panes.md). The previous
plan assumed gateway-owned workspace pane/layout state. The revised direction is
that the frontend owns every pane and canvas concern, while the gateway remains
the source of truth for resources and transports.

## Context

Kodex should move the desktop main pane area to a Dockview-based tiling workspace
that can host multiple pane instances: thread panes, generated UI panes, and
terminal panes. The AppShell sidebar, search, account footer, preferences, and
non-thread main panes remain outside the tiling canvas.

The architectural boundary is:

- Frontend owns panes and canvas state: open pane list, duplicate pane instances,
  pane ids, active pane, Dockview splits/tabs/sizes, scroll, focus, local drafts,
  generated UI local hide, and local persistence.
- Backend owns resources and shared lifecycle state: threads, generated UI
  sessions/documents, terminal sessions, approvals, queued input, read state,
  presence, canonical thread snapshots, SSE events, and terminal websocket
  transport.
- A pane is a frontend view instance over a backend resource. Closing a pane
  removes only the local view. Archiving a thread, submitting generated UI,
  stopping a terminal, or killing a terminal remains an explicit backend
  resource action.

This plan is a hard pivot from the partially implemented gateway-owned workspace
work. Cleanup is part of the plan.

## Current State

Backend:

- Public API and OpenAPI registration live in `apps/gateway/src/api.rs`.
- Route modules are registered through `apps/gateway/src/routes/mod.rs`.
- Store modules and migrations live in `apps/gateway/src/store.rs`,
  `apps/gateway/src/store/`, and `apps/gateway/src/store/migrations.rs`.
- The superseded work added `apps/gateway/src/workspaces.rs`,
  `apps/gateway/src/routes/workspaces.rs`, `apps/gateway/src/store/workspaces.rs`,
  workspace tables in `apps/gateway/src/store/migrations.rs`, and
  `/v1/workspaces/*` OpenAPI entries.
- Multi-resource SSE support is still useful: `apps/gateway/src/events.rs`,
  `apps/gateway/src/events_replay.rs`, and `apps/gateway/src/store/events.rs`
  now support `includeGlobal=true` plus deduped `threadIds`.
- Existing resource APIs remain the backend contract for panes:
  `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/routes/generated_ui.rs`,
  `apps/gateway/src/routes/terminals.rs`, and terminal websocket support in
  `apps/gateway/src/terminal.rs`.

Frontend:

- `apps/web/src/App.tsx` still coordinates selected-thread state, composer
  orchestration, generated UI selection, terminal launcher state, overlays, and
  shell-level routing.
- `apps/web/src/shell/KodexShellView.tsx` is the shell boundary. It should render
  the workspace only inside `AppShell.Main`; the sidebar remains outside Dockview.
- The superseded work added `apps/web/src/workspace/WorkspaceProvider.tsx`,
  `WorkspaceShell.tsx`, `WorkspaceDock.tsx`, `paneTypes.ts`,
  `resourceSubscriptions.ts`, and pane components under `apps/web/src/panes/`.
  Those modules are useful starting points, but their state source must change
  from gateway workspace APIs to a local frontend pane store.
- `apps/web/src/events/stream.ts` already has `includeGlobal` and `threadIds`
  query support, and `apps/web/src/events/stream.test.ts` covers deduping.
- `apps/web/src/generatedUi/GeneratedUiPane.tsx` is a reusable iframe host that
  can be targeted by pane props instead of selected-thread state.
- `apps/web/src/terminal/useGatewayTerminalSession.ts` already accepts options
  for a preferred terminal id and create request, which fits terminal panes.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts` remains selected-thread
  scoped. Thread panes need a resource hook keyed by `threadId`, with one
  workspace-level SSE stream feeding all subscribed thread resources.

Repo constraints:

- `AGENTS.md` requires generated OpenAPI types for public backend DTOs and no
  handwritten duplicate API contracts.
- Shared lifecycle correctness must stay gateway-owned when it matters across
  tabs or clients.
- Browser-local state is explicitly allowed for drafts, focus, hover, modals,
  scroll, drag interactions, unsent attachments, and purely visual state.
- SSE bandwidth guardrails must not regress: canonical visible timeline rendering
  consumes `thread_view` snapshots/patches/item deltas, not raw timeline replay,
  and duplicate panes must not multiply event streams for the same thread.

## Target Architecture

### Pane Model

Define local frontend pane types independent of generated OpenAPI workspace DTOs:

```ts
type WorkspacePane =
  | {
      id: string;
      kind: "thread";
      title?: string | null;
      target:
        | { mode: "existing"; threadId: string }
        | { mode: "draft"; projectId?: string | null };
    }
  | {
      id: string;
      kind: "generatedUi";
      title?: string | null;
      target:
        | { mode: "latest"; threadId: string }
        | { mode: "session"; threadId: string; sessionId: string };
    }
  | {
      id: string;
      kind: "terminal";
      title?: string | null;
      target: { terminalId?: string | null; cwd?: string | null; command?: string | null };
    };
```

Local workspace state:

```ts
type WorkspacePaneState = {
  panes: WorkspacePane[];
  activePaneId: string | null;
  dockviewLayout: unknown | null;
  schemaVersion: number;
};
```

Persist this per browser client behind a small adapter such as
`apps/web/src/workspace/paneStore.ts`. Start with localStorage or IndexedDB. The
adapter interface should be narrow enough to swap to backend storage later, but
backend storage is not in v1.

### Backend Resource Contract

No gateway pane/workspace API is needed for v1. Panes call existing resource
APIs:

- Thread panes: `GET /v1/threads/{threadId}`,
  `GET /v1/threads/{threadId}/timeline/pages`, `POST /v1/threads/{threadId}/input`,
  `POST /v1/threads/{threadId}/interrupt-current`, thread settings/read routes,
  queue routes, and generated thread create routes for draft materialization.
- Generated UI panes: `GET /v1/threads/{threadId}/generated-ui`,
  generated UI document routes, and generated UI submit routes.
- Terminal panes: `GET/POST/DELETE /v1/terminals` and
  `GET /v1/terminals/{terminalId}/ws`.
- Approvals and queued inputs stay gateway-owned and keyed by resource ids.

### Workspace Event Stream

The frontend workspace opens one SSE connection for all open panes:

```http
GET /v1/events?includeGlobal=true&threadIds=thread-1,thread-2
```

`threadIds` is derived from unique thread-bound pane targets:

- existing thread panes,
- generated UI panes,
- future thread-bound panes.

Two panes showing the same thread produce one subscribed thread id. Terminal panes
do not add thread subscriptions. Terminal PTY bytes remain websocket-only.

### Shell Boundary

Dockview is constrained to the existing main pane area rendered by
`AppShell.Main`. The sidebar, search, account footer, preferences modal, sidebar
resize behavior, Automations pane, and Project pane remain outside the tiling
canvas.

## Milestones

### 1. Close And Clean Up Gateway-Owned Workspace Work

Scope:

- `plans/workspace-panes.md`, `plans/index.md`
- `apps/gateway/src/workspaces.rs`
- `apps/gateway/src/routes/workspaces.rs`
- `apps/gateway/src/store/workspaces.rs`
- `apps/gateway/src/api.rs`
- `apps/gateway/src/routes/mod.rs`
- `apps/gateway/src/store.rs`
- `apps/gateway/src/store/migrations.rs`
- `apps/web/src/api/client.ts`
- `apps/web/src/api/generated/schema.ts`
- `apps/web/src/api/queryKeys.ts`
- `apps/web/src/test/gatewayMock.ts`
- `apps/web/src/test/mvpAppHarness.tsx`

Work:

- Mark the old plan `Superseded` and add this plan to `plans/index.md`.
- Delete the gateway workspace DTOs, routes, store module, route registration,
  OpenAPI path registration, and workspace table migration additions.
- Remove workspace CRUD/focus client wrappers and generated frontend API types.
- Remove mock gateway workspace route handling from frontend test fixtures.
- Keep multi-resource SSE backend and frontend changes only if their tests prove
  they preserve the bandwidth guardrails.

Exit criteria:

- `rg "/v1/workspaces|WorkspaceDto|WorkspacePaneCreateRequest|dockview_layout_json|workspace_panes" apps/gateway/src apps/web/src` returns no live API/client references.
- `cargo fmt` passes.
- `cargo test workspace` no longer depends on deleted workspace APIs; use
  `cargo test events` or the closest focused SSE filter for retained event work.
- `cd apps/web && npm test -- events/stream.test.ts` passes.
- `cd apps/web && npm run build` passes after generated API types are updated.

### 2. Add A Local Pane Store And Pane Registry

Scope:

- `apps/web/src/workspace/paneTypes.ts`
- `apps/web/src/workspace/paneStore.ts`
- `apps/web/src/workspace/WorkspaceProvider.tsx`
- `apps/web/src/workspace/paneRegistry.tsx`
- `apps/web/src/workspace/resourceSubscriptions.ts`
- `apps/web/src/workspace/*.test.ts`

Work:

- Replace generated `WorkspaceDto`/`WorkspacePaneDto` usage with local pane
  model types.
- Add a local pane reducer with explicit commands:
  `openThreadPane`, `openDraftThreadPane`, `duplicatePane`, `openGeneratedUiPane`,
  `openTerminalPane`, `updatePaneTarget`, `closePane`, `focusPane`, and
  `persistDockviewLayout`.
- Add a storage adapter with a versioned serialized shape and fallback default:
  one draft chat pane when no local state exists.
- Keep backend-migration optional by making the adapter an implementation detail,
  not part of pane component props.
- Keep `resourceSubscriptions.ts` deduping by resource id, not pane count.

Exit criteria:

- Focused workspace tests cover local persistence, corrupted-state fallback,
  duplicate same-thread panes, terminal pane creation policy, pane close without
  deleting resources, and subscription dedupe.
- `cd apps/web && npm test -- workspace` passes.

### 3. Rebuild Dockview Shell As Pure Client UI

Scope:

- `apps/web/src/workspace/WorkspaceShell.tsx`
- `apps/web/src/workspace/WorkspaceDock.tsx`
- `apps/web/src/styles/workspace.css`
- `apps/web/src/shell/KodexShellView.tsx`
- `apps/web/src/App.tsx`

Work:

- Render `WorkspaceShell` only inside `AppShell.Main` when `mainPane === "thread"`.
- Keep Automations and Project views outside the Dockview workspace for v1.
- Make Dockview layout changes update only local pane store state.
- Ensure sidebar thread row actions open or focus local thread panes.
- Add explicit "Open in new pane" or duplicate actions where the sidebar or pane
  chrome needs to create another pane pointing at the same resource.
- Avoid making URL/back-forward the source of truth for canvas arrangement. URL
  may focus/open a local pane for a thread route, but it must not encode splits
  or full layout.

Exit criteria:

- Focused shell/workspace tests cover root default pane, thread route open/focus,
  sidebar row open/focus, explicit duplicate thread pane, terminal launcher,
  and Automations/Project remaining outside Dockview.
- `cd apps/web && npm run build` passes.
- `$agent-browser` desktop validation shows panes can split, tab, resize, close,
  duplicate, and restore from local storage without console errors.

### 4. Add Workspace-Level SSE Aggregation

Scope:

- `apps/web/src/events/stream.ts`
- new `apps/web/src/events/useWorkspaceLiveStream.ts` or workspace-provider stream module
- `apps/web/src/workspace/resourceSubscriptions.ts`
- `apps/gateway/src/events.rs`
- `apps/gateway/src/events_replay.rs`
- `apps/gateway/src/store/events.rs`

Work:

- Keep or finish the backend `EventsQuery` support for `includeGlobal` and
  comma-separated `threadIds`.
- Reject conflicting query combinations such as `threadId` plus `threadIds`.
- Ensure replay and live delivery include high-volume `thread_view.patch` and
  `thread_view.item_delta` only for subscribed thread ids.
- Ensure global operational events still reach the shell/sidebar when
  `includeGlobal=true`.
- Ensure generated UI events are delivered for subscribed thread ids.
- Ensure terminal panes do not subscribe to thread events and PTY bytes never go
  over SSE.
- Replace selected/global dual-stream assumptions in the workspace path with one
  deduped workspace stream.

Exit criteria:

- Backend focused event tests prove unsubscribed thread-view events are excluded,
  duplicate thread ids do not duplicate delivery, generated UI events are scoped,
  raw timeline history remains excluded, and refresh-required is emitted per
  affected subscribed thread.
- `cd apps/web && npm test -- events/stream.test.ts` proves query dedupe and
  reconnect preservation.
- A frontend workspace test proves two same-thread panes open one SSE connection
  with one `threadIds` entry.

### 5. Migrate Thread Panes

Scope:

- `apps/web/src/panes/thread/`
- `apps/web/src/timeline/useSelectedThreadTimeline.ts`
- new `apps/web/src/timeline/useThreadResourceTimeline.ts` or resource provider
- `apps/web/src/composer/`
- `apps/web/src/approvals/`
- `apps/web/src/queuedInputs/`
- `apps/web/src/threads/useThreadViewPresence.ts`
- selected App tests under `apps/web/src/App.*.test.tsx`

Work:

- Extract selected-thread timeline behavior into a `threadId` keyed resource
  hook/store that consumes workspace-stream events.
- Keep same-thread duplicate panes sharing the resource event subscription and
  resource reducer state while retaining pane-local scroll/expanded-row state.
- Keep composer drafts keyed by pane id for unsent draft state.
- Materialize draft panes by calling existing thread create APIs, then update the
  local pane target to `{ mode: "existing", threadId }`.
- Route send, queue, stop, compact, approval decisions, read receipts, and older
  history loading by explicit `threadId`, not global selected-thread refs.
- Replace one-selected-thread presence with a multi-visible-thread model, or
  explicitly gate that as a follow-up if presence remains selected-thread-only.

Exit criteria:

- Focused timeline/resource tests pass.
- Existing reducer guardrail tests remain passing.
- Same-thread duplicate pane tests show one resource subscription and matching
  live updates in both panes.
- Draft pane materialization preserves the composer through create/send and
  patches the local pane target.
- Same-user two-tab test shape proves send/stop/read convergence through gateway
  state/SSE, not one tab's React selected state.

### 6. Migrate Generated UI Panes

Scope:

- `apps/web/src/panes/generatedUi/`
- `apps/web/src/generatedUi/`
- `apps/web/src/api/queryKeys.ts`
- `apps/web/src/events/liveRouting.ts`
- `apps/web/src/App.generatedUi.test.tsx`

Work:

- Target generated UI panes by pane target `{ threadId, sessionId? }`.
- Move generated UI query, submit, local hide, and optimistic-visible message
  behavior out of selected-thread-only App state.
- Route generated UI SSE events through the workspace stream and update the
  relevant resource cache.
- Keep auto-open policy explicit. For v1, prefer manual open unless product
  intent later requires model-created sessions to create local panes.

Exit criteria:

- `cd apps/web && npm test -- generatedUi` passes.
- Tests cover subscribed thread generated UI updates and ignored unsubscribed
  thread sessions.
- A generated UI pane can submit to its target thread without relying on global
  selected-thread state.
- `$agent-browser` validates thread plus generated UI panes tiled side by side.

### 7. Migrate Terminal Panes

Scope:

- `apps/web/src/panes/terminal/`
- `apps/web/src/terminal/useGatewayTerminalSession.ts`
- `apps/web/src/terminal/XtermTerminal.tsx`
- `apps/web/src/terminal/GatewayTerminalHost.tsx`
- terminal tests under `apps/web/src/terminal/` and `apps/web/src/panes/terminal/`

Work:

- Use the pane target `{ terminalId?, cwd?, command? }` to recover or create a
  terminal session through existing terminal APIs.
- Patch only the local pane target after session creation or recovery.
- Keep terminal output on `/v1/terminals/{terminalId}/ws`.
- Make duplicate terminal pane creation default to a new terminal session rather
  than a second writable view on the same PTY.
- Closing a terminal pane must not implicitly delete the terminal session.

Exit criteria:

- Focused terminal hook and pane tests pass.
- Opening terminal-only workspaces produces no thread SSE subscriptions.
- `$agent-browser` validates terminal start, output, resize, reconnect, stop, and
  adjacency with another pane.

### 8. Migrate Legacy App Tests And Cleanup Selected-Thread Shell State

Scope:

- `apps/web/src/App.tsx`
- `apps/web/src/shell/useShellSelection.ts`
- `apps/web/src/shell/KodexShellView.tsx`
- `apps/web/src/App.*.test.tsx`
- obsolete selected stream modules/tests after replacement coverage exists

Work:

- Update route/navigation tests to assert frontend-owned pane behavior rather
  than one selected main thread surface.
- Remove or narrow old selected/global stream assumptions that conflict with the
  workspace-level stream.
- Shrink `App.tsx` back toward shell coordination by moving pane behavior into
  workspace, timeline resource, generated UI pane, and terminal pane modules.
- Keep old behavior only where it remains product-relevant outside the workspace
  canvas, such as Automations and Project panes.

Exit criteria:

- `App.tsx` no longer owns a single selected timeline as the only renderable
  thread surface.
- Focused app-level tests pass for navigation, sidebar, composer settings,
  composer input, approvals, generated UI, subagents, and automations.
- `cd apps/web && npm test` passes or any intentionally deferred failures are
  captured in this plan before status moves to Complete.

### 9. Contract Regeneration, Profiling, And Browser Validation

Scope:

- Generated OpenAPI and frontend schema artifacts
- `README.md` only if commands or user-visible setup change
- `plans/index.md`
- performance notes from local SSE profiling

Work:

- Regenerate frontend OpenAPI types after removing workspace API paths and
  keeping any event-query schema changes.
- Run focused and broad backend/frontend verification.
- Profile SSE traffic for:
  - one thread pane,
  - two panes of the same thread,
  - three unique thread panes,
  - thread plus generated UI for the same thread,
  - terminal-only workspace.
- Confirm duplicate same-thread panes do not multiply wire bytes beyond expected
  global shell overhead.

Exit criteria:

- Generated API artifacts match gateway DTOs.
- No `/v1/workspaces/*` paths remain in `/openapi.json` or
  `apps/web/src/api/generated/schema.ts`.
- No raw transcript history is replayed through `/v1/events`.
- No terminal PTY bytes are emitted through `/v1/events`.
- Browser validation covers desktop fine-pointer pane split/tab/resize/close,
  duplicate thread pane, generated UI pane, terminal pane, and narrow viewport
  non-overlap.

## Verification Matrix

Backend:

- `cargo fmt`
- `cargo test events`
- `cargo test terminals`
- `cargo test generated_ui`
- `cargo test -p kodex-gateway`
- `cargo test` before marking the whole plan Complete when practical

Frontend:

- `cd apps/web && npm test -- workspace`
- `cd apps/web && npm test -- events/stream.test.ts`
- `cd apps/web && npm test -- generatedUi`
- `cd apps/web && npm test -- terminal`
- `cd apps/web && npm test -- App.mvp.composer-input`
- `cd apps/web && npm test -- App.mvp.approvals-stream`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`

Generated API:

- Start the gateway.
- `cd apps/web && npm run generate:api`
- Confirm `apps/web/src/api/generated/schema.ts` removed workspace paths and kept
  intended event query shape changes.

Browser validation:

- Use `$agent-browser` against the local Vite/gateway stack.
- Validate desktop pane split, tab, resize, close, restore, duplicate thread
  pane, thread plus generated UI, and terminal pane.
- Validate narrow viewport non-overlap even though mobile Dockview interactions
  are out of v1 scope.
- Inspect browser console for Dockview, xterm, iframe, and SSE errors.

Performance guardrails:

- Record event count and approximate wire bytes for duplicate same-thread panes
  versus one thread pane.
- Record three-unique-thread pane traffic and verify growth is per unique thread.
- Confirm terminal-only workspace has no thread SSE subscription and no PTY bytes
  in SSE.

## Risks And Open Questions

- Thread resource extraction is the largest frontend risk. `App.tsx` and
  `apps/web/src/timeline/useSelectedThreadTimeline.ts` still carry selected-thread
  assumptions that many old tests encode.
- Presence/read receipts currently assume one visible thread in
  `apps/web/src/threads/useThreadViewPresence.ts` and
  `apps/gateway/src/thread_presence.rs`. Multi-pane visibility needs explicit
  handling before the plan is Complete.
- Generated UI auto-open remains a product decision. Manual pane open is the v1
  recommendation until model-created local panes have clear cross-tab semantics.
- Local pane persistence means different browser tabs can have different canvas
  arrangements. That is intentional for v1. Shared workspaces would be a future
  adapter swap and product decision.
- Dockview layout JSON should stay frontend-only. Do not reintroduce gateway
  validation or persistence for canvas arrangement unless a later shared-workspace
  plan explicitly changes ownership.
