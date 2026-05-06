# Deep Link Navigation Plan

## Status

Complete

## Goal

Make thread selection URL-owned so users can deep link to a thread, use browser Back/Forward to move between thread selections, and use mobile Back to return from a thread to the thread selector. The default `/` route should load the app with an empty thread pane and hydrate composer defaults with `null`; it should not auto-select the first project or first thread.

## Product Contract

- `/` loads the app with the sidebar populated and the main thread pane empty.
- The initial composer defaults are hydrated with `null`, not the first project.
- `/threads/:threadId` selects and loads that thread.
- Browser Back from `/threads/:threadId` to `/` clears selection and returns the main pane to the empty thread state.
- Browser Back and Forward between `/threads/a` and `/threads/b` switch selected threads without requiring reload.
- If `/threads/:threadId` cannot be loaded, keep the URL and show a dedicated not-found/unavailable thread pane with a route back to the selector.
- On desktop, the sidebar and main pane remain visible. Route changes affect selection, not layout.
- On mobile, the same selected-thread route drives content, and a `panel=threads` query state can show the thread selector because only one pane is visible at a time.
- On direct mobile deep links to `/threads/:threadId`, seed a selector history entry so the first Back action shows the thread selector rather than immediately leaving the app.
- Deep-linked routes must be served by the existing production SPA fallback; API routes must continue to win over frontend fallback.

## Final Decisions

- Use URL query state for mobile pane visibility: `panel=threads` is shareable, reloadable, and inspectable.
- Desktop ignores `panel=threads` visually and should not normalize it away. Desktop-originated route writes can still use canonical paths without the query.
- Direct mobile deep links seed history by replacing the first entry with `/threads/:threadId?panel=threads`, then pushing `/threads/:threadId`.
- Missing or inaccessible thread IDs render a dedicated not-found/unavailable pane while preserving `/threads/:threadId`.
- Use a frontend `routeSelectedThread`/`selectedThreadFallback` first, rather than changing the gateway `ThreadSummary` contract to include normalized `projectId` or thread-kind metadata.
- Keep `WorkspaceSidebar`'s Projects versus Chats mobile scope local-only; do not encode it in the URL.
- Keep new chat/project drafts URL-less until first send materializes a real thread, then route to `/threads/:threadId`.

## Current Code Seams

Frontend selection and shell state:

- `apps/web/src/App.tsx`
  - Owns `selectedProjectId`, `threadsByProjectId`, `selectedThreadId`, `draftChatThreadSelected`, `draftThreadProjectId`, `timeline`, and `mobilePanel`.
  - `selectedThread` is currently derived only from `threadsByProjectId[selectedProjectId]` or `chatThreads`, so a deep-linked thread that is not in loaded sidebar lists needs a selected-thread fallback or list reconciliation.
  - `autoSelectedThreadIdRef` exists only to track startup/sidebar-order auto-selection and should be removed with the auto-load behavior.
  - `loadProjectThreads(projectId, { selectWhenLoaded })` currently performs first-thread selection when `selectWhenLoaded` is true.
  - `selectProject(projectId)` currently selects the first thread for an already-loaded project or requests selection after project thread load.
  - `handleSelectThread` and `handleSelectChatThread` are the current user-driven selection seams and should become route-writing wrappers around one shared selection helper.
  - `handleShowMobileSidebar` and `handleShowMobileThread` currently mutate only React state; they should write route panel state when mobile history behavior is enabled.
- `apps/web/src/shell/initialLoad.ts`
  - Currently calls `hydrateComposerDefaults(firstProjectId)` and passes `selectWhenLoaded: project.id === firstProjectId`.
  - This should instead hydrate with `null`, load projects and thread lists without selection, and leave route selection to `App.tsx`.
- `apps/web/src/timeline/useSelectedThreadTimeline.ts`
  - Already loads the canonical selected-thread snapshot through `getThreadDetail(selectedThreadId)`.
  - This is the right detail-loading path for deep-linked threads. The missing piece is allowing `ThreadPanel` to render while the thread summary is only known from the route/detail response.
- `apps/web/src/threads/ThreadPanel.tsx`
  - Already has an empty thread pane and a `Browse threads` escape hatch.
  - The header sidebar button is the mobile entry point for writing `panel=threads`.
- `apps/web/src/threads/WorkspaceSidebar.tsx`
  - Owns local mobile sidebar scope (`projects` or `chats`) separately from shell `mobilePanel`.
  - Thread row clicks are already centralized through `onSelectThread` and `onSelectChatThread`.
- `apps/web/src/styles/preferences.css`
  - Mobile pane visibility is already keyed by `.kodex-shell[data-mobile-panel="threads"]` and `.kodex-shell[data-mobile-panel="chat"]`.
- `apps/web/src/test/mvpAppHarness.tsx`
  - Provides mocked routes, thread fixtures, and `FakeEventSource`; this is the right harness for URL-selection tests.

Backend/static serving:

- `apps/gateway/src/static_assets.rs`
  - `ServeDir(...).fallback(ServeFile::new(index))` should already serve `/threads/:threadId` as the SPA when frontend assets are configured.
- `apps/gateway/src/routes/mod.rs`
  - Existing static-serving tests cover fallback behavior. Add a focused assertion for `/threads/thread-1`.
- `apps/gateway/src/routes/threads.rs`
  - `GET /v1/threads/{thread_id}` already exists and maps to app-server `thread/read includeTurns:true`, so no gateway API route is required for basic deep linking.
- `apps/web/src/api/client.ts`
  - `getThreadDetail(threadId)` already wraps the detail route.

## URL Model

Preferred initial URL shapes:

```text
/                         empty pane, sidebar populated
/?panel=threads           empty pane, mobile selector visible
/threads/thread-1         selected thread-1, chat pane visible on mobile
/threads/thread-1?panel=threads
                          selected thread-1, mobile selector visible
```

Desktop should ignore `panel` visually because both sidebar and main pane are visible. Keeping the query in the URL is still acceptable because it lets the same history entries behave naturally on mobile.

Route parsing rules:

- A path matching `/threads/:threadId` yields `{ threadId, panel }`.
- `/` yields `{ threadId: null, panel }`.
- Unknown non-API paths should render a not-found app pane or replace to `/` only if they are outside the owned route set. For owned thread routes, missing thread data must show the dedicated thread not-found pane while preserving the URL.
- Decode `threadId` with `decodeURIComponent`. Encode all route writes with `encodeURIComponent`.
- Preserve unrelated query parameters only if there is a concrete reason. Otherwise the route helper should own only `panel`.

## Implementation Plan

### Milestone 1: Route Helpers And Empty Startup

Failing tests first:

- Loading `/` renders the empty thread pane and does not fetch `GET /v1/threads/thread-1`.
- Startup hydrates composer defaults with `projectId=null` instead of the first project.
- Project and chat lists still load and render in the sidebar.

Implementation:

- Add a small route helper module, for example `apps/web/src/shell/navigation.ts`, with:
  - `parseKodexLocation(location)`.
  - `threadPath(threadId, options?)`.
  - `emptyPath(options?)`.
  - `isOwnedKodexRoute(location)`.
  - `replaceKodexRoute(route)` and `pushKodexRoute(route)` helpers, or keep writes in `App.tsx` if the helper should stay pure.
- Update `loadInitialKodexState`:
  - Change `onProjectsLoaded` so it no longer returns the first project for initial selection.
  - Call `hydrateComposerDefaults(null)`.
  - Call `loadProjectThreads(project.id)` with no `selectWhenLoaded`.
  - Keep chat threads, approvals, account, models, and rate limits loading unchanged.
- Update `App.tsx`:
  - Initialize selection from the parsed route, not from first loaded project threads.
  - Remove startup auto-selection and `autoSelectedThreadIdRef` reconciliation.
  - Keep `selectedProjectId` null until an explicit project selection, project-thread click, or route/detail reconciliation identifies a project.

Exit conditions:

- Existing startup/sidebar tests are updated to expect an empty pane.
- No project/thread is selected on `/`.
- Composer remains usable only for an explicit chat/project draft or selected thread, matching current `canCompose` rules.

### Milestone 2: Shared Selection And Route Writes

Failing tests first:

- Clicking a project thread pushes `/threads/:threadId` and selects that thread.
- Clicking a chat thread pushes `/threads/:threadId` and selects that thread.
- Browser Back to `/` clears `selectedThreadId` and shows the empty pane.
- Browser Forward reselects the thread and reloads its timeline.

Implementation:

- Extract selection helpers in `App.tsx`:
  - `selectProjectThread({ projectId, threadId, source })`.
  - `selectChatThread({ threadId, source })`.
  - Or a single helper with `{ kind: "project" | "chat" | "route"; projectId?: string; threadId }`.
- `handleSelectThread` and `handleSelectChatThread` should push the new route, then call the shared selection helper.
- Add a `popstate` effect in `App.tsx`:
  - Parse the new location.
  - If no `threadId`, clear selected thread, draft thread state, timeline entry, and selected-project thread highlight as needed.
  - If `threadId`, select it from loaded project/chat lists when possible, otherwise select it as route-owned and let the detail snapshot supply summary data.
- Avoid duplicate timeline resets when the selected route has not changed.

Exit conditions:

- Browser history drives selection consistently.
- Existing thread selection behavior still loads queued inputs, snapshot, selected-thread SSE, resume attach, read state, approvals, and composer settings.

### Milestone 3: Route-Owned Thread Summary Fallback

Failing tests first:

- Loading `/threads/thread-2` renders `thread-2` even when `thread-2` is not the first auto-loaded project thread.
- Loading `/threads/chat-thread-1` renders the chat thread when it is present only in chat list or only in the detail response.
- A route-selected thread not yet present in sidebar lists still renders the thread header after `GET /v1/threads/:threadId` resolves.

Implementation:

- Add `routeSelectedThread` or `selectedThreadFallback` state in `App.tsx`.
- Compute `selectedThread` as:
  - project-thread match from `threadsByProjectId`,
  - chat-thread match from `chatThreads`,
  - fallback thread summary whose id matches `selectedThreadId`,
  - otherwise null.
- Update `handleSelectedThreadSnapshot(thread)`:
  - Always update fallback when it matches `selectedThreadId`.
  - Continue `replaceThread(thread)` so loaded sidebar rows are refreshed.
  - If a robust project association is available, reconcile `selectedProjectId` and the correct list. Current `ThreadSummary` does not expose `projectId` in generated types, so this may rely on loaded list membership or future backend normalization.
- Clear fallback when:
  - navigating to `/`,
  - selecting a different known sidebar thread,
  - archiving the selected thread.

Exit conditions:

- Deep-linked selected threads render even before sidebar membership is known.
- Sidebar active state appears when the selected thread is present in loaded sidebar lists.
- Unknown or inaccessible thread IDs produce the existing error banner and do not leave stale timeline content visible.
- Unknown or inaccessible thread IDs render the dedicated thread not-found pane after the detail read fails.

### Milestone 4: Mobile Panel History

Failing tests first:

- From `/`, tapping `Browse threads` or `Show sidebar` pushes `/?panel=threads` and sets `data-mobile-panel="threads"`.
- From `/threads/thread-1`, tapping `Show sidebar` pushes `/threads/thread-1?panel=threads`.
- Selecting a thread while the selector is open pushes `/threads/thread-2` and sets `data-mobile-panel="chat"`.
- Browser Back from `/threads/thread-2` returns to the previous selector entry and sets `data-mobile-panel="threads"`.

Implementation:

- Extend route parsing with `panel: "threads" | "chat" | null`.
- Treat missing `panel` as `"chat"` in app state.
- Update `handleShowMobileSidebar` and `handleShowMobileThread` to write `panel` route state instead of only mutating React state.
- On thread selection from mobile selector, push the selected thread route without `panel=threads`.
- For direct mobile deep links, seed a selector history entry on first mobile load:
  - Replace the current entry with `/threads/:id?panel=threads`.
  - Push `/threads/:id`.
  - Guard this so it happens once per app load and only for direct selected-thread entries without an existing `panel` query.
- Keep desktop behavior unaffected; the `panel` query should only change the narrow CSS-driven visible pane.

Exit conditions:

- Mobile Back can move from thread content to selector after in-app thread selection.
- Desktop Back/Forward switches or clears selected thread without layout flicker.
- `mobileSidebarScope` in `WorkspaceSidebar.tsx` remains local unless product wants Projects/Chats scope in the URL too.

### Milestone 5: Static Fallback And Verification

Failing tests first:

- Gateway static-serving route test proves `/threads/thread-1` returns `index.html` when frontend dist is configured.
- API routes still win over fallback.

Implementation:

- Add a focused backend test near existing frontend static serving tests in `apps/gateway/src/routes/mod.rs`.
- No route implementation change is expected unless the test reveals a fallback gap.

Verification:

- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- `cargo test -p kodex-gateway` if static fallback tests are touched.
- Browser smoke at desktop width:
  - `/` empty pane.
  - click thread, Back to empty, Forward to thread.
- Browser smoke at mobile width:
  - `/` empty pane.
  - open selector.
  - select thread.
  - Back returns to selector.
  - direct `/threads/:id` Back returns to selector, then a second Back leaves the app/history entry.

## State Ownership Notes

- URL/history owns selected thread identity and mobile panel history.
- Gateway/app-server still own thread content, lifecycle, queued inputs, approvals, read state, and account/session state.
- React state remains a projection cache for loaded lists, selected snapshot fallback, local drafts, hover/focus, and mobile sidebar scope.
- This does not add cross-client shared routing state. Two tabs can intentionally be on different URLs while still converging on gateway-owned thread state.

## Non-Goals

- No new router library unless the route helper becomes complex enough to justify it.
- No gateway API change for basic deep linking.
- No durable selected-thread preference in gateway or local storage.
- No project auto-selection on startup.
- No automatic creation of a draft thread on `/`.
- No draft URLs in the first implementation. New chat and new project-thread drafts remain local until materialized.
- No project/chat/sidebar scope encoded in URL unless explicitly chosen later.
- No public-safe deployment/auth changes.

## Remaining Clarifications

- Should selecting a project title remain collapse/expand only, or should project selection exist independently from thread selection? The recommended first pass keeps current project-title behavior unchanged.
- If a route-selected thread belongs to a project whose thread list has not loaded yet, should the sidebar auto-expand that project when membership becomes known? The recommended first pass does not auto-expand.
- Should archive of the selected thread replace the current URL with `/`, or preserve `/threads/:id` and show an archived/unavailable state? The recommended first pass replaces to `/` after successful archive because archive is an explicit removal from active navigation.
- How strict should tests be around `history.length` for direct mobile deep-link seeding? The recommended first pass should assert observable URL and panel behavior, not exact `history.length`.
