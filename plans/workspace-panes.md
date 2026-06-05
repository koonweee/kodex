# Workspace Panes Architecture Plan

## Status

Superseded.

Superseded by [Frontend-owned workspace panes plan](frontend-owned-workspace-panes.md).

This plan is retained as historical context for the Dockview exploration and the
multi-resource SSE bandwidth guardrails. Its central architecture is no longer
the desired direction: the gateway should not own workspace pane instances,
Dockview layout, active pane focus, or canvas arrangement. The replacement plan
makes all pane and canvas state frontend-owned, with the backend providing only
resource APIs and transports for threads, generated UI sessions, terminals,
approvals, lifecycle/read state, and event streams.

Implementation checkpoint:

- Implemented gateway-owned workspace panes/layout persistence, mutation routes, OpenAPI regeneration, and workspace SSE events.
- Implemented a single workspace SSE stream with `includeGlobal=true` plus unique subscribed `threadIds`; backend live and replay filtering keeps `thread_view.patch` and `thread_view.item_delta` scoped to subscribed threads, while low-volume coordination events can still update shell/sidebar state.
- Implemented the desktop Dockview shell inside the existing main pane only. The AppShell sidebar, preferences, account footer, sidebar resize, and non-thread main panes remain outside the tiling canvas.
- Implemented initial thread, generated UI, and terminal pane renderers. Terminal PTY bytes remain on terminal websocket transport.
- Review fixes landed for draft thread pane materialization, Dockview focus selecting the focused thread pane, generated UI pane reachability from thread panes, and in-place Dockview updates for unchanged panel sets.
- Remaining hardening: full chat composer orchestration is still selected-thread-oriented. The active selected thread pane can render the existing composer bridge, but true independent multi-chat composer state, old timeline affordance parity, and the legacy selected-thread test migration remain unfinished.

## Goal

Replace the single selected-main-pane web shell with a desktop-first Dockview workspace that can host multiple pane instances. The initial pane types are:

- Thread panes: one or more existing threads, including duplicate views of the same thread, plus draft thread panes for new chat/project-thread creation.
- Generated UI panes: the latest or pinned generated UI session for a thread.
- Terminal panes: gateway terminal sessions backed by the existing terminal HTTP and websocket APIs.

This is a hard-cut web architecture change. The implementation does not need to preserve the current selected-thread route/UI contract, but it must preserve the existing gateway-owned lifecycle guarantees, OpenAPI discipline, and SSE bandwidth guardrails.

## Product Decisions

- Use Dockview for desktop pane layout, tabs, splitting, drag/drop, resizing, and serializable layout state.
- Constrain Dockview to the existing main pane/workspace area. The wrapping app shell, including sidebar search/projects/chats, account footer, preferences, and sidebar resize behavior, remains outside the tiling canvas.
- Treat `paneId` as a workspace view instance id. Treat `threadId`, `generatedUiSessionId`, and `terminalId` as resource ids. Multiple panes may point to the same resource where the pane type allows it.
- SSE traffic must scale with unique subscribed resources, not pane count. Two panes showing the same thread must not create two thread event streams or duplicate reducer work.
- Workspace state that affects shared correctness is gateway-owned: open panes, pane targets, active pane, layout document, workspace revision, event subscriptions, and read/presence effects.
- Browser-local state remains pane-local: scroll position, focus, expanded timeline rows, composer draft text, temporary hidden/generated UI visibility, resize drag state before commit, and xterm connection state.
- Desktop is the v1 target. Narrow/mobile must keep the app usable and non-overlapping, but full mobile Dockview interactions are out of scope for this plan.
- Generated UI remains the initial pane type name and API target. The proposed app-surface migration in [mcp-app-surfaces.md](mcp-app-surfaces.md) should be a later adapter swap, not a dependency for this workspace rewrite.
- Terminal byte output stays on the terminal websocket. SSE may carry only terminal session metadata events if needed.

## Current Kodex Grounding

Backend:

- Public routes and OpenAPI registration live in `apps/gateway/src/api.rs`.
- Route modules are registered through `apps/gateway/src/routes/mod.rs`.
- SQLite store modules live under `apps/gateway/src/store/`, with schema changes in `apps/gateway/src/store/migrations.rs`.
- Event filtering and replay are split across `apps/gateway/src/events.rs`, `apps/gateway/src/events_replay.rs`, and `apps/gateway/src/store/events.rs`.
- Current event replay intentionally excludes raw transcript history and uses `thread_view.refresh_required` to converge when a selected-thread replay cursor missed required canonical state.
- Thread snapshots and canonical timeline patches are served through `GET /v1/threads/{threadId}`, `GET /v1/threads/{threadId}/timeline/pages`, `thread_view.patch`, `thread_view.item_delta`, and `thread_view.refresh_required`.
- Generated UI is currently thread-bound in `apps/gateway/src/routes/generated_ui.rs` with `GET /v1/threads/{threadId}/generated-ui`, document serving, submit, and `generated_ui.*` events.
- Terminal sessions are already gateway-owned in `apps/gateway/src/terminal.rs` and `apps/gateway/src/routes/terminals.rs`, with `GET/POST/DELETE /v1/terminals` and `GET /v1/terminals/{terminalId}/ws`.
- Foreground thread presence currently assumes one visible thread per browser session in `apps/web/src/threads/useThreadViewPresence.ts` and `apps/gateway/src/thread_presence.rs`.

Frontend:

- `apps/web/src/App.tsx` currently coordinates one selected thread, one `TimelineState`, one selected generated UI session, one selected queued-input query, one subagent sidebar, one composer, global/selected SSE streams, and shell-level overlays.
- `apps/web/src/shell/KodexShellView.tsx` currently switches between `"thread"`, `"automations"`, and `"project"` and embeds generated UI as a selected-thread side split.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts` is explicitly selected-thread scoped and owns snapshot loading, selected-thread SSE connection, reducer batching, missed-delta refresh, and older-history pagination.
- `apps/web/src/events/useGlobalLiveStream.ts` and `apps/web/src/events/stream.ts` currently implement global-plus-selected stream de-duplication using `excludeThreadId`.
- `apps/web/src/timeline/TimelineView.tsx` already uses `react-virtuoso`, so long transcripts are protected from raw DOM growth.
- `apps/web/src/generatedUi/GeneratedUiPane.tsx` is already a fairly self-contained iframe host, but its lifecycle is wired through selected-thread state.
- `apps/web/src/terminal/GatewayTerminalHost.tsx` is a global shell host around the terminal session hook and `XtermTerminal`.
- API wrappers live in `apps/web/src/api/client.ts`, query keys in `apps/web/src/api/queryKeys.ts`, and generated OpenAPI types in `apps/web/src/api/generated/schema.ts`.

Planning and workflow:

- `AGENTS.md` requires frontend API types to come from generated OpenAPI artifacts.
- Behavior-changing work should start with failing tests when practical.
- Browser-visible UI work should include `$agent-browser` validation.
- Shared lifecycle state must be gateway-owned, and behavior touching shared thread/project/session state should include same-user two-tab test coverage.
- Keep `plans/index.md` current when plan status changes.

## Target Architecture

### Resource Versus Pane Ownership

Use this ownership split throughout the plan:

```text
Gateway workspace document
  workspaceId
  revision
  activePaneId
  pane instances
  dockview layout JSON

Pane instance
  paneId
  kind
  title override
  target resource reference
  placement metadata

Resource state
  thread timeline, queued inputs, approvals, generated UI session, terminal session
  keyed by resource id, shared by all panes targeting that resource

Pane-local state
  scroll, expansion, focus, drafts, transient errors, local hide, websocket connection state
  keyed by paneId in the browser
```

Suggested pane target DTOs:

```ts
type WorkspacePaneDto =
  | {
      id: string;
      kind: "thread";
      title?: string | null;
      target:
        | { mode: "existing"; threadId: string; composer: "enabled" | "readonly" }
        | { mode: "draft"; projectId?: string | null; composer: "enabled" };
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

Thread panes may be duplicated. Generated UI panes may be duplicated only when each duplicate is an independent view of the same session. Terminal pane duplication should create a new terminal session by default rather than attach two writable panes to the same PTY.

### Backend Workspace API

Add a new workspace domain:

- `apps/gateway/src/workspaces.rs` for DTO helpers, validation, and layout integrity checks.
- `apps/gateway/src/store/workspaces.rs` for SQLite persistence.
- `apps/gateway/src/routes/workspaces.rs` for HTTP routes.
- OpenAPI registration in `apps/gateway/src/api.rs`.
- Route module registration in `apps/gateway/src/routes/mod.rs`.

Suggested tables:

```sql
create table if not exists workspaces (
    id text primary key,
    revision integer not null,
    active_pane_id text,
    dockview_layout_json text not null,
    created_at text not null,
    updated_at text not null
);

create table if not exists workspace_panes (
    id text primary key,
    workspace_id text not null,
    kind text not null,
    title text,
    target_json text not null,
    sort_order integer not null,
    created_at text not null,
    updated_at text not null,
    foreign key(workspace_id) references workspaces(id) on delete cascade
);
```

Suggested HTTP routes:

- `GET /v1/workspaces/default`
  - Returns the default workspace document, creating a default draft-thread workspace if missing.
- `PUT /v1/workspaces/default`
  - Replaces panes, active pane, and Dockview layout with `baseRevision`.
  - Returns `409` with the current workspace on stale revision.
- `POST /v1/workspaces/default/panes`
  - Adds a pane and returns the updated workspace.
  - Request includes `baseRevision`, `pane`, and optional placement metadata.
- `PATCH /v1/workspaces/default/panes/{paneId}`
  - Updates title or target, such as materializing a draft thread or assigning a terminal id.
- `DELETE /v1/workspaces/default/panes/{paneId}`
  - Removes one pane instance without necessarily deleting the target resource.
- `POST /v1/workspaces/default/focus`
  - Sets `activePaneId` without requiring a full layout update.

Validation rules:

- Workspace revision is monotonic and gateway-assigned.
- Every Dockview panel id must match exactly one `workspace_panes.id`.
- Every pane id appears at most once in Dockview layout JSON.
- Pane target JSON must validate against its pane kind.
- Thread pane targets must be existing thread ids or draft descriptors.
- Generated UI targets must include a thread id and optionally a concrete session id.
- Terminal targets may omit `terminalId` only when the pane is ready to create/recover a session on mount.

Workspace events:

- Add replayable operational events such as `workspace.updated`, `workspace.pane_upserted`, `workspace.pane_deleted`, and `workspace.focus_updated`.
- Include compact workspace metadata in events. Avoid embedding full thread snapshots, generated UI HTML, or terminal output in workspace events.

### Multi-Resource SSE Contract

Replace the selected/global dual stream with one workspace stream:

```http
GET /v1/events?cursor=123&includeGlobal=true&threadIds=thread-1,thread-2
Accept: text/event-stream
```

Implementation notes:

- Extend `EventsQuery` in `apps/gateway/src/events.rs` to carry a deduped thread id set and `includeGlobal`.
- Replace `event_matches` in `apps/gateway/src/events_replay.rs` with a resource-set predicate that delivers:
  - global operational events when `includeGlobal=true`,
  - thread-scoped events for subscribed unique thread ids,
  - workspace events for the default workspace,
  - terminal metadata events if introduced.
- Preserve `is_operational_replay_event`, `is_normal_live_event`, and raw-timeline replay exclusion.
- Update selected-thread replay recovery to multi-thread recovery: if replay detects a missed thread-view cursor or invalid patch for a subscribed thread, emit one `thread_view.refresh_required` for that affected thread.
- Do not stream raw app-server timeline lifecycle events to the browser as visible transcript sources.
- Do not stream terminal PTY bytes over SSE.

Frontend stream rules:

- Add `apps/web/src/events/useWorkspaceLiveStream.ts`.
- Compute `subscribedThreadIds` from unique workspace pane targets:
  - thread pane existing targets,
  - generated UI pane targets,
  - any thread-bound pane added later.
- Open exactly one SSE connection for the workspace.
- Demux events into resource stores by `threadId` and event kind.
- Pane components never create their own SSE connections.

### Frontend Workspace Domain

Add a workspace feature directory:

```text
apps/web/src/workspace/
  WorkspaceShell.tsx
  WorkspaceDock.tsx
  WorkspaceProvider.tsx
  paneRegistry.tsx
  paneTypes.ts
  resourceSubscriptions.ts
  useWorkspaceModel.ts
  workspaceLayoutCodec.ts
```

Responsibilities:

- `WorkspaceShell.tsx` replaces only the selected-main-pane content inside `AppShell.Main`; it does not own or render the sidebar, account footer, preferences modal, theme provider, or other global shell chrome.
- `WorkspaceDock.tsx` wraps Dockview and maps Dockview panel ids to pane registry entries.
- `WorkspaceProvider.tsx` owns the loaded workspace document, optimistic layout updates, revision conflict handling, and pane commands.
- `paneRegistry.tsx` maps pane kind to render component, icon, title resolver, close policy, duplication policy, and resource subscriptions.
- `resourceSubscriptions.ts` dedupes subscribed thread ids and other future resource ids from current panes.
- `workspaceLayoutCodec.ts` validates Dockview layout snapshots before sending them to the gateway.

Suggested pane component contract:

```ts
type PaneComponentProps<TPane extends WorkspacePaneDto> = {
  pane: TPane;
  isActive: boolean;
  workspace: {
    openPane(request: OpenPaneRequest): void;
    updatePane(paneId: string, patch: PanePatch): void;
    closePane(paneId: string): void;
    focusPane(paneId: string): void;
  };
};
```

`App.tsx` should shrink toward provider wiring:

- Mantine and Query providers.
- Color scheme and theme workbench routing.
- Account/preferences/lightbox/Markdown preview shell state until those move into smaller providers.
- `WorkspaceShell` plus `WorkspaceSidebar`.

### Thread Pane Architecture

Add:

```text
apps/web/src/panes/thread/
  ThreadPane.tsx
  ThreadPaneController.tsx
  ThreadPaneComposer.tsx
  useThreadPaneModel.ts
```

Extract thread resources:

```text
apps/web/src/timeline/
  ThreadTimelineResourceProvider.tsx
  useThreadTimelineResource.ts
```

Resource behavior:

- Key timeline state by `threadId`, not selected thread.
- Load initial snapshot with `getThreadDetail(threadId)`.
- Apply `thread_view.patch`, `thread_view.item_delta`, and `thread_view.refresh_required` from the workspace stream.
- Fetch older pages with `getThreadTimelinePage(threadId, { cursor })`.
- Refcount or track subscribers so inactive/unopen thread resources can be evicted later.
- Preserve `TimelineView` virtualization and reducer guardrails.

Pane-local behavior:

- Keep composer drafts by `paneId`, not `threadId`, so two panes of the same thread can have independent unsent drafts.
- Keep timeline scroll/expanded work rows by `paneId`.
- A draft thread pane starts as `{ mode: "draft", projectId? }`.
- On first submit, call existing create thread/chat routes, then patch the pane target to `{ mode: "existing", threadId }`.
- Existing-thread submit, stop, compact, queued input, and generated UI submit routing must use the pane target `threadId`; no global selected-thread refs.

Presence/read behavior:

- Replace single selected-thread presence with workspace-visible thread presence.
- A browser session should report visible presence for every thread with at least one visible thread pane or visible generated UI pane, using a stable `clientId:threadId` key rather than one client id that can represent only one thread.
- Read receipts should mark a thread seen when a visible thread pane is opened/focused and after canonical snapshot convergence, not merely when a sidebar row is clicked.

### Generated UI Pane Architecture

Add:

```text
apps/web/src/panes/generatedUi/
  GeneratedUiPaneHost.tsx
  useGeneratedUiPaneModel.ts
```

Reuse:

- `apps/web/src/generatedUi/GeneratedUiPane.tsx`
- `apps/web/src/generatedUi/cache.ts`
- `apps/web/src/generatedUi/themeDocument.ts`

Behavior:

- A latest-mode pane watches `queryKeys.generatedUi(threadId)` and updates when `generated_ui.session_upserted` arrives.
- A session-mode pane pins a concrete session id and should show a recoverable missing/session-archived state if that session is not readable.
- Generated UI submit should send through the generated UI session endpoint and then update the thread resource for the target thread via canonical events/snapshot, not selected-thread optimistic state.
- Local hide is keyed by `paneId` and `sessionId:revision`; closing a pane is a workspace mutation.
- If a model-created generated UI session arrives for a thread with an open thread pane and no generated UI pane, the workspace may auto-open a generated UI pane using a gateway workspace mutation. This default policy should be covered by tests and can later move into Kodex Control self-control if model tools should open panes explicitly.

App-surface future seam:

- Keep the generated UI pane adapter small. If [mcp-app-surfaces.md](mcp-app-surfaces.md) lands first, the pane kind can switch to an app-surface model by replacing the generated UI resource hook and iframe host while preserving the workspace pane contract.

### Terminal Pane Architecture

Add:

```text
apps/web/src/panes/terminal/
  TerminalPane.tsx
  useTerminalPaneModel.ts
```

Refactor existing terminal code:

- Keep `apps/web/src/terminal/XtermTerminal.tsx` as the xterm/websocket integration.
- Keep `apps/web/src/terminal/terminalProtocol.ts`.
- Split the current `GatewayTerminalHost.tsx` into pane chrome plus optional compatibility wrapper during migration.
- Update `useGatewayTerminalSession` or replace it with a pane-aware hook that accepts `{ terminalId?, cwd?, command? }` and returns session actions.

Behavior:

- Mounting a terminal pane with no valid `terminalId` shows "Start terminal" or auto-creates a terminal based on pane target policy, then patches the pane target with the created `terminalId`.
- Closing a terminal pane does not implicitly kill the terminal session unless the user chooses the explicit stop action.
- Deleting/stopping a terminal session leaves the pane open with a recoverable state, or closes the pane only when the user chooses a combined stop-and-close action.
- Duplicating a terminal pane should create a new terminal session by default.
- Terminal session metadata can be refreshed with `GET /v1/terminals`; terminal output remains on `/v1/terminals/{terminalId}/ws`.

### Sidebar And Navigation

The sidebar becomes a pane launcher and workspace navigator:

- The sidebar stays outside Dockview. It is not a draggable/resizable workspace pane and is not stored in the Dockview layout JSON.
- Thread row click focuses an existing thread pane for that thread or opens a new one, depending on modifier/action policy.
- Add explicit row/menu actions for "Open in new pane" and, later, "Open generated UI".
- New chat/project-thread creates a draft thread pane.
- Automations and project settings can remain outside this plan or become future pane types. If they remain outside, keep them reachable without complicating the initial pane registry.
- Browser URL can encode workspace and optionally active pane, for example `/workspace/default?pane=pane_123`. Do not encode full Dockview layout or selected thread in the URL.
- Back/Forward should focus pane-level state when practical, but gateway workspace state remains canonical.

## Milestones

### 1. Workspace Backend Foundation

Scope: `apps/gateway/src/workspaces.rs`, `apps/gateway/src/store/workspaces.rs`, `apps/gateway/src/store/migrations.rs`, `apps/gateway/src/routes/workspaces.rs`, `apps/gateway/src/api.rs`, `apps/gateway/src/routes/mod.rs`.

Work:

- Start with failing backend tests for default workspace creation, pane create/update/delete, revision conflict, active pane updates, and invalid layout rejection.
- Add workspace tables and store methods.
- Define `WorkspaceDto`, `WorkspacePaneDto`, pane target DTOs, mutation request/response DTOs, and layout validation helpers with `utoipa::ToSchema`.
- Add the workspace routes and register them in OpenAPI.
- Emit compact workspace operational events on successful mutations.

Exit criteria:

- Focused backend workspace tests pass.
- `cargo test workspace` or the closest focused test filter passes.
- `cargo fmt` passes.
- `/openapi.json` includes workspace DTOs and routes after regeneration in a later integration milestone.

### 2. Multi-Resource Event Stream Without Bandwidth Regression

Scope: `apps/gateway/src/events.rs`, `apps/gateway/src/events_replay.rs`, `apps/gateway/src/store/events.rs`, `apps/gateway/src/routes/mod.rs` tests, `apps/web/src/events/stream.ts`, `apps/web/src/events/stream.test.ts`.

Work:

- Replace selected/global stream query assumptions with a multi-resource event query.
- Preserve operational replay filtering and raw timeline history exclusion.
- Extend replay recovery to emit `thread_view.refresh_required` per subscribed thread that missed cursor-critical state.
- Add backend tests proving:
  - unsubscribed thread events are not delivered,
  - duplicate thread ids do not duplicate delivery,
  - generated UI events are delivered only for subscribed thread ids,
  - terminal PTY bytes are never represented as SSE events,
  - replay still excludes raw timeline history and emits refresh-required where needed.
- Update the frontend stream URL builder and tests to use one workspace stream with unique thread ids.

Exit criteria:

- Focused backend event tests pass.
- `cd apps/web && npm test -- events/stream.test.ts` passes.
- Tests fail if one pane creates one SSE stream or if duplicate thread ids appear in the stream query.
- The plan's expected traffic rule is enforced: unique resources, not pane count.

### 3. Frontend Workspace Shell And Dockview Integration

Scope: `apps/web/package.json`, lockfile, `apps/web/src/workspace/`, `apps/web/src/shell/KodexShellView.tsx`, `apps/web/src/App.tsx`, `apps/web/src/styles/workspace.css`, `apps/web/src/App.css`.

Work:

- Add Dockview dependency.
- Add `WorkspaceProvider`, `WorkspaceDock`, pane registry, layout codec, workspace API wrappers, and query keys.
- Render placeholder panes for `thread`, `generatedUi`, and `terminal` using persisted workspace data.
- Connect Dockview layout changes to debounced workspace `PUT` mutations with revision handling.
- Keep desktop layout stable within the existing `AppShell.Main`.
- Add focused tests for pane registry rendering, layout serialization, pane close/focus commands, and revision conflict handling.

Exit criteria:

- `cd apps/web && npm test -- workspace` passes.
- `cd apps/web && npm run build` passes after generated API types are updated.
- `$agent-browser` validation shows a desktop Dockview workspace can split, resize, tab, close, and restore placeholder panes without console errors.

### 4. Thread Resource Store And Thread Pane Migration

Scope: `apps/web/src/timeline/useSelectedThreadTimeline.ts`, new timeline resource provider files, `apps/web/src/panes/thread/`, `apps/web/src/threads/ThreadPanel.tsx`, `apps/web/src/composer/`, `apps/web/src/approvals/`, `apps/web/src/queuedInputs/`, `apps/web/src/events/useWorkspaceLiveStream.ts`.

Work:

- Start with frontend tests for two panes targeting the same thread sharing one resource subscription while keeping independent composer drafts.
- Extract selected-thread timeline behavior into a `threadId` keyed resource provider.
- Route workspace SSE events to the appropriate thread resource.
- Move selected-thread composer orchestration into pane-aware `ThreadPaneComposer` logic.
- Support existing-thread panes and draft-thread panes.
- Update queued input, approvals, context usage, thread metadata, stop/compact, and older-history loading to take explicit `threadId`.
- Replace selected-thread presence with multi-visible-thread presence.
- Preserve `TimelineView` virtualization and row reducer guardrails.

Exit criteria:

- Focused timeline/resource tests pass.
- Existing timeline reducer tests remain passing.
- Same-thread duplicate panes share one event subscription/resource state and render the same live updates.
- Draft pane materialization patches the workspace pane target to the new `threadId`.
- Two-tab test shape proves a thread send/stop/read update converges through gateway state/SSE, not one tab's React selected state.

### 5. Generated UI Pane Migration

Scope: `apps/web/src/panes/generatedUi/`, `apps/web/src/generatedUi/`, `apps/web/src/generatedUi/cache.ts`, `apps/web/src/events/liveRouting.ts`, `apps/web/src/api/queryKeys.ts`, `apps/gateway/src/routes/generated_ui.rs` only if workspace auto-open needs backend participation.

Work:

- Add `GeneratedUiPaneHost` that targets a pane's thread/session instead of selected thread.
- Move generated UI query, submit, hide, and optimistic-visible-message behavior out of `App.tsx`.
- Ensure generated UI events update resource cache through workspace live stream.
- Add an auto-open policy for new generated UI sessions when an associated thread pane is visible and no generated UI pane exists, or explicitly document that users open generated UI panes manually.
- Keep the adapter narrow so app-surface migration can replace the resource model later.

Exit criteria:

- `cd apps/web && npm test -- generatedUi` passes.
- Tests cover generated UI updates for subscribed threads and ignore unsubscribed thread sessions.
- A generated UI pane can submit to its target thread without relying on global selected-thread state.
- `$agent-browser` validation shows thread plus generated UI panes can be tiled, resized, closed, reopened, and updated by SSE.

### 6. Terminal Pane Migration

Scope: `apps/web/src/panes/terminal/`, `apps/web/src/terminal/`, `apps/web/src/api/client.ts`, `apps/web/src/api/queryKeys.ts`, optional terminal metadata SSE in `apps/gateway/src/routes/terminals.rs`.

Work:

- Refactor the current terminal host into pane chrome plus reusable xterm runtime.
- Add pane-aware terminal session hook with recover/create/stop actions.
- Patch terminal pane targets with created `terminalId`.
- Preserve websocket replay, resize fitting, reconnect, and stop behavior.
- Add tests for stale/missing terminal id recovery, stop behavior, and duplicate-terminal-pane policy.

Exit criteria:

- Focused terminal tests pass.
- Opening a terminal pane does not create any thread SSE subscription.
- Terminal output flows only over websocket.
- `$agent-browser` validation shows a terminal pane can start, receive output, resize, reconnect, and stop without breaking adjacent panes.

### 7. Sidebar, Commands, And Old Shell Removal

Scope: `apps/web/src/threads/WorkspaceSidebar.tsx`, `apps/web/src/shell/useShellSelection.ts`, `apps/web/src/shell/navigation.ts`, `apps/web/src/App.tsx`, `apps/web/src/shell/KodexShellView.tsx`, related `App.*.test.tsx`.

Work:

- Replace selected-thread selection handlers with workspace pane commands.
- Row click focuses or opens a thread pane according to the chosen default policy.
- Add explicit "Open in new pane" actions for threads.
- New chat/new project-thread opens draft thread panes.
- Remove generated UI side split and terminal global dock host from `KodexShellView`.
- Remove selected-thread-only global state from `App.tsx` once all three pane types have moved.
- Update navigation tests around workspace URL and active pane.

Exit criteria:

- `App.tsx` no longer owns a single selected timeline or selected generated UI session.
- `KodexShellView` hosts the workspace rather than selected pane variants.
- Existing sidebar caches still update from gateway-owned events.
- Focused app tests pass.
- `$agent-browser` validation covers sidebar row open/focus/new-pane flows.

### 8. Contract Regeneration, Performance Profiling, And Cleanup

Scope: generated OpenAPI artifacts, frontend generated API types, README if commands/behavior change, plan/index updates, old selected-stream code removal.

Work:

- Run `cargo fmt`.
- Run focused backend tests, then `cargo test` when practical.
- Regenerate `/openapi.json` and `apps/web/src/api/generated/schema.ts` after workspace/event DTO changes.
- Run frontend unit tests and build.
- Run `$agent-browser` desktop validation across pane create, split, drag, resize, duplicate thread pane, generated UI pane, and terminal pane flows.
- Profile SSE traffic against at least:
  - one thread pane,
  - two panes of the same thread,
  - three unique thread panes,
  - thread plus generated UI for the same thread,
  - terminal-only pane.
- Remove obsolete selected-thread stream code and stale tests only after equivalent workspace tests exist.

Exit criteria:

- Generated OpenAPI and frontend schema are committed and match gateway DTOs.
- Bandwidth profiling shows duplicate same-thread panes do not multiply SSE bytes.
- No raw transcript history is replayed through `/v1/events`.
- No terminal PTY bytes are emitted through `/v1/events`.
- Full verification status is documented before marking this plan Active/Complete.

## Verification Matrix

Backend:

- `cargo fmt`
- `cargo test workspace`
- `cargo test events`
- `cargo test terminals`
- `cargo test generated_ui`
- `cargo test` before completing the whole plan

Frontend:

- `cd apps/web && npm test -- workspace`
- `cd apps/web && npm test -- events/stream.test.ts`
- `cd apps/web && npm test -- generatedUi`
- `cd apps/web && npm test -- terminal`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`

Generated API:

- Start the gateway.
- `cd apps/web && npm run generate:api`
- Confirm `apps/web/src/api/generated/schema.ts` changes are expected.

Browser validation:

- Use `$agent-browser` against the local Vite/gateway stack.
- Validate desktop fine-pointer pane split, tab, resize, close, restore, duplicate thread pane, thread plus generated UI, and terminal pane.
- Validate narrow viewport non-overlap and clear fallback even though full mobile Dockview UX is out of scope.
- Inspect browser console for Dockview, xterm, iframe, and SSE errors.

Performance guardrails:

- Record event count and approximate wire bytes for duplicate same-thread panes versus one thread pane.
- Record three-unique-thread pane traffic and verify growth is per unique thread.
- Confirm terminal-only traffic has no thread SSE subscription and no PTY bytes in SSE.

## Risks And Open Questions

- Dockview layout JSON validation: Dockview owns a rich layout document. The gateway should validate only pane id consistency and store opaque layout JSON; over-validating Dockview internals would be brittle.
- Workspace sharing semantics: this plan makes the default workspace gateway-owned and shared across same-gateway clients. If product intent becomes per-browser workspaces, add a browser workspace id and keep thread lifecycle/read state gateway-owned.
- Generated UI auto-open policy: model-created generated UI probably should open a pane automatically near the associated thread, but this needs careful two-tab behavior. The plan makes this explicit in milestone 5.
- App-surface overlap: the proposed app-surface migration may land before or during this work. Keep the generated UI pane adapter narrow so the pane contract does not depend on generated-ui-specific DTOs.
- Presence/read receipts: current presence tracks one thread per client id. Multi-pane visibility requires a keyed presence model or multiple client ids per visible thread.
- Terminal writable duplicates: attaching two writable panes to the same PTY can surprise users. Default duplicate behavior should create a new terminal session.
- URL/back-forward behavior: exact browser navigation semantics are less important than gateway-owned workspace state for v1. Keep active pane in the URL only if it does not fight shared workspace focus.
- Existing active plans: [mcp-app-surfaces.md](mcp-app-surfaces.md), [slash-compact-command.md](slash-compact-command.md), and [thread-foreground-presence-notification-suppression.md](thread-foreground-presence-notification-suppression.md) touch related code. Coordinate before marking this plan Active.
