# Performance Overhaul Plan

## Status

Archived.

This plan is closed after partial implementation. Timing instrumentation, sidebar startup improvements, visible older-history handling, submit routing improvements, and static asset delivery changes landed; the remaining compact DTO/detail hydration and browser render profiling work is not active.

## Context

Kodex can still feel sluggish after the completed sidebar, timeline, thread-open, and streaming-delta performance work. The current target is an extensive overhaul of perceived latency for:

- cold or hard page load,
- sidebar readiness,
- selecting/opening existing threads,
- draft-thread first send,
- existing-thread send acknowledgement,
- long-thread snapshot and timeline rendering.

Recent local profiling against a real `codex app-server` on May 21, 2026 found:

- `GET /v1/sidebar/threads`: 239-269 ms locally with 10 chat rows and no project rows in a temp gateway DB.
- App-server chat `thread/list` over 87 chat cwd candidates: about 274 ms.
- `GET /v1/threads/019e24de-5866-7112-8414-93c48e4264c2`: 294-372 ms locally, returning about 1.26 MB for 19 turns and 141 timeline items.
- Small selected-thread snapshots: 7-23 ms locally.
- Temporary project `POST /v1/threads`: about 653 ms.
- First `POST /v1/threads/{threadId}/input` after thread creation: about 112 ms.
- Warm existing-thread submit plus first selected-thread `thread_view.patch`: about 10 ms.

The working inference is that remote Singapore-to-San Francisco latency makes every round trip more visible, but the app still has local critical-path costs large enough to fix.

Relevant code seams:

- Frontend startup and sidebar hydration:
  - `apps/web/src/App.tsx`
  - `apps/web/src/threads/useSidebarThreadsSnapshot.ts`
  - `apps/web/src/threads/cache.ts`
  - `apps/web/src/threads/WorkspaceSidebar.tsx`
- Frontend selected timeline loading:
  - `apps/web/src/timeline/useSelectedThreadTimeline.ts`
  - `apps/web/src/timeline/reducer.ts`
  - `apps/web/src/timeline/batch.ts`
  - `apps/web/src/timeline/TimelineView.tsx`
- Frontend composer send lifecycle:
  - `apps/web/src/composer/useComposerOrchestration.ts`
  - `apps/web/src/composer/ComposerPanel.tsx`
- Gateway routes and app-server adapter:
  - `apps/gateway/src/routes/threads.rs`
  - `apps/gateway/src/routes/turns.rs`
  - `apps/gateway/src/app_server_api.rs`
  - `apps/gateway/src/app_server.rs`
  - `apps/gateway/src/events.rs`
  - `apps/gateway/src/thread_view.rs`
  - `apps/gateway/src/store.rs`
  - `apps/gateway/src/static_assets.rs`
- Existing performance plans:
  - `plans/thread-open-performance.md`
  - `plans/sidebar-thread-list-performance.md`
  - `plans/sidebar-payload-trimming.md`
  - `plans/thread-load-critical-path.md`
  - `plans/streaming-delta-performance.md`
  - `plans/optimistic-user-messages.md`

## Current State

- `/v1/sidebar/threads` removed the old browser fan-out, but the gateway still performs app-server thread list work in the request path. Project groups are currently processed serially in `get_sidebar_threads`, and chat listing still builds a list of cwd candidates before calling app-server `thread/list`.
- `GET /v1/threads/{threadId}` calls `thread_read_history_window`, which performs `thread/read includeTurns:false`, `thread/turns/list itemsView:"full"`, then `thread_completed_turn_count_light`. Large item payloads are still serialized through `ThreadTimelineSnapshotItem.payload`.
- Normal composer submit calls `submit_thread_input`, resolves skills, saves options, then calls `turn_lifecycle::refreshed_active_turn_id`. That path uses `thread_read includeTurns:true` before deciding whether to queue or start.
- `useComposerOrchestration` sets `isComposerSubmitting` before the request and only clears it once the canonical user message for the turn appears in selected timeline state.
- Draft-thread sends still require thread creation before the turn input is associated with a real thread id. Current optimistic message behavior does not fully hide the thread-creation gap.
- Static frontend serving is plain `ServeDir` plus `ServeFile`; hashed assets are built by Vite, but gateway cache headers and compression are not configured in `static_assets.rs`.
- `AGENTS.md` requires public API shape changes to flow through Rust DTOs, generated OpenAPI, and generated frontend TypeScript types. Browser-visible lifecycle state must remain gateway/app-server owned and correct across two tabs.

## Principles

- Measure before changing behavior, then keep the measurements as regression checks.
- Optimize perceived latency first: user input should visibly land in the UI before slower app-server work completes.
- Faster must not mean less trustworthy: visible UI may show pending or deferred state, but it must not imply work is complete until the gateway/app-server source of truth confirms it.
- Keep app-server as the durable transcript source. Do not introduce a browser-owned shared state source.
- Prefer gateway-owned pending state over local-only optimistic state when another tab should see it.
- Keep API contract changes generated from Rust DTOs and regenerate frontend OpenAPI types.
- Avoid `thread/turns/items/list` until upstream documents it as supported, even though schemas exist.
- Keep localhost/trusted-VPN deployment assumptions explicit; this is not a public internet hardening effort.

## UX Non-Regression Guardrails

- No blank primary pane after a direct thread route resolves enough metadata to identify the thread; show either usable timeline rows, an explicit loading state, or an explicit deferred-content affordance.
- Deferred timeline content must preserve chronological order, row identity, copy/open affordances, and scroll position. A faster initial view must not silently hide history, command output, file diffs, images, or collaboration details.
- Heavy timeline rows may render compact previews, but each preview must show a clear same-row path to load or open the full content. The preview must not look like the full content when it is truncated.
- Omitted historical ranges must be visible as missing history, not as an apparently complete transcript. Loading older history must preserve chronology, recover cleanly on failure, and avoid moving the user's current reading position.
- User-submitted input may render immediately as pending, but pending must be visually and accessibly distinct from confirmed. Failure must be visible, recoverable, and not silently dropped.
- Sidebar acceleration must not make navigation feel stale. Newly created threads, archive/delete effects, rename, pin/unpin, unread/read state, and selected-row state must update immediately and must not be resurrected by a late cache or snapshot.
- Performance budgets must be paired with user-facing checks: no unexpected scroll jump, no hidden loading after ready, no lost visible rows, no disabled composer without an explanatory state, and no duplicate user messages after reconciliation.

## Target Budgets

Milestone 1 must establish current-machine baselines before implementation changes. Initial targets for the overhaul are:

- Sidebar snapshot: under 150 ms local warm median and under 75 KB response on the current local database shape.
- Selected small thread open: under 100 ms local warm median to first usable timeline rows.
- Selected large thread open: under 200 ms local warm median to first usable timeline rows, with older/heavy content allowed to hydrate later.
- Deferred timeline detail fetch: under 250 ms local warm median for already-known heavy item detail when data is local/app-server warm, or an explicit loading/error state that keeps the preview usable until full content arrives.
- Existing-thread send acknowledgement: under 100 ms local warm median to visible accepted/pending row.
- Draft-thread first send: under 150 ms local warm median to visible accepted/pending row, even if real thread creation continues.
- Static hard refresh over a high-latency link: one HTML request plus cacheable compressed assets, with hashed JS/CSS served from browser cache after the first load.
- UX stability budget: after a timeline reports ready, vertical scroll position should not jump except for deliberate user-triggered loads; any unavoidable layout growth must keep the user's current reading anchor stable.

These are plan budgets, not completion claims. If instrumentation proves a target is unrealistic without unacceptable tradeoffs, update this plan before implementation proceeds.

## Milestones

### 1. Measurement Harness And Route Timing

Scope: `apps/gateway/src/app_server.rs`, `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/api.rs`, route tests, and a profiling script under `apps/gateway/scripts` or `apps/web/scripts`.

Work:

- Add lightweight app-server RPC timing around `JsonRpcAppServer::request`, recording method name, duration, response byte size, and error classification.
- Add route-level timing for hot gateway routes:
  - `GET /v1/sidebar/threads`
  - `GET /v1/threads/{threadId}`
  - `GET /v1/threads/{threadId}/timeline/pages`
  - `POST /v1/threads`
  - `POST /v1/chats/threads`
  - `POST /v1/threads/{threadId}/input`
- Expose timings through structured logs first. Add `Server-Timing` headers only if it can be done without leaking sensitive prompt or file data.
- Add a repeatable local profiling script that captures request timings, response sizes, and a small summary JSON under `/private/tmp`.
- Add an `$agent-browser` profiling recipe for hard reload, sidebar ready, selected-thread open, draft send, existing-thread send, and long-thread scroll.
- Document how to distinguish app-server time, gateway serialization time, network time, and browser render time.
- Include UX observations in the profile summary: first visible thread content, composer enabled/disabled state, pending-send visibility, scroll jumps, duplicate rows, and whether deferred content was explicitly marked.

Exit criteria:

- Focused tests cover any new timing/header helper behavior without depending on wall-clock exactness.
- A profile run produces comparable before/after numbers for the hot routes.
- The plan budgets above are updated if the first structured run contradicts the current local observations.
- No prompt text, raw item payloads, local file contents, or auth data appear in metrics labels.
- The profiling recipe fails or reports a warning when speed improves by hiding visible content without an explicit deferred-content affordance.

### 2. Sidebar Startup Critical Path

Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/app_server_api.rs`, `apps/web/src/threads/useSidebarThreadsSnapshot.ts`, `apps/web/src/threads/WorkspaceSidebar.tsx`, `apps/web/src/threads/cache.ts`, and sidebar tests.

Work:

- Make `get_sidebar_threads` internally concurrent where correctness permits:
  - project thread groups should be fetched with bounded concurrency instead of a simple serial loop,
  - chat and pinned sections should not wait on unrelated project groups when they do not depend on them.
- Cache or incrementally maintain chat cwd candidates derived from `~/Documents/Codex` so every sidebar request does not rescan the directory tree from scratch.
- Evaluate whether project groups can use a multi-cwd app-server `thread/list` strategy without starving busy projects. Preserve the existing first-page-per-project contract unless tests prove a new contract is acceptable.
- Add an optional short-lived in-memory sidebar snapshot cache only after measuring concurrency and cwd caching. If added, invalidate it on gateway-owned mutations and live events that affect sidebar summaries: create, archive, pin, unpin, rename, read-state, thread metadata, and thread upsert.
- Include deletion or removal events in the invalidation contract if that surface exists in the milestone implementation or lands before the cache does.
- Keep scoped section pagination routes as the source for "Show more" after the startup snapshot.
- Ensure startup snapshot merging remains protected against late snapshots overwriting local create/archive/pin/unpin changes.
- Treat stale-sidebar behavior as a product regression, not an acceptable cache tradeoff. Local mutation results and live gateway events must outrank cached snapshots.

Exit criteria:

- Backend tests prove project group fetches are no longer accidentally serialized when multiple projects exist.
- Backend tests prove chat cwd candidate caching invalidates when date or child directories change, or the plan explicitly chooses a time-based cache with a bounded stale window.
- Frontend tests prove sidebar hydration, project/chat/pinned selection, show-more pagination, and late SSE merge behavior remain correct.
- Frontend tests prove create, archive, delete/remove where supported, rename, pin/unpin, unread/read, and selected-row updates are not undone by a later sidebar snapshot or cache hit.
- Profile results compare `/v1/sidebar/threads` before and after this milestone.

### 3. Selected Thread Snapshot Payload And Read Path

Scope: `apps/gateway/src/routes/threads.rs`, `apps/gateway/src/app_server_api.rs`, `apps/gateway/src/thread_view.rs`, `apps/web/src/timeline/*`, generated OpenAPI, and timeline tests.

Work:

- Split selected-thread loading into a faster first usable response plus lazy hydration for expensive content:
  - keep thread metadata and active/live state in the first response,
  - keep enough recent user/assistant/tool rows to make the thread usable,
  - defer older turns and oversized item details to existing or new page/detail endpoints.
- Add a byte-aware or item-aware cap to the initial timeline window. A fixed turn count is insufficient because one turn can contain large command output, diffs, or collaboration payloads.
- Introduce compact web-facing timeline item DTOs for hot-path rendering. Avoid returning duplicated raw app-server item payloads when renderers only need a normalized subset.
- For large command output, file diffs, image metadata, and collaboration payloads, return a preview summary in the initial timeline and fetch full detail on expansion or open when needed.
- Define a visible deferred-content model before implementation:
  - truncated rows must say or signal that more content is available,
  - omitted older ranges must render a clear "load older" or equivalent history boundary instead of making the first loaded row look like the start of the transcript,
  - loading full content must be same-row or same-pane, not a disorienting navigation,
  - copy/open actions must make clear whether they operate on preview or full content,
  - row expansion and older-history insertion must preserve the user's reading anchor,
  - failed detail or older-history loads must leave a retryable state instead of removing the affordance.
- Replace `thread_completed_turn_count_light` full scans in the selected-thread hot path with a cheaper strategy:
  - reuse gateway runtime/read state when already known,
  - maintain a gateway-owned completed-turn counter from live terminal events,
  - fall back to app-server scans only when opening an unknown historical thread.
- Preserve snapshot and SSE convergence rules:
  - browser rendering must still consume canonical snapshots, `thread_view.patch`, and `thread_view.item_delta`,
  - `thread_view.refresh_required` remains a refetch signal only,
  - stale snapshots must not overwrite newer live state.

Exit criteria:

- Backend tests cover compact timeline serialization, large-item preview behavior, and full-detail retrieval for command output, file diff, image metadata, and collaboration items when those item kinds are deferred.
- Frontend tests prove the timeline renders compact initial items, expands/fetches full details when requested, and reconciles later full snapshots/patches without duplicate rows.
- Frontend tests prove truncated/deferred rows remain visibly distinct from complete rows and preserve chronology, copy/open affordances, and scroll position after expansion.
- Frontend tests prove omitted older-history ranges are visible, load in chronological order, expose retry on failure, and do not make the initial snapshot look like a complete transcript.
- Two-tab tests cover one tab opening a compact snapshot while another tab receives live patches; both converge to the same visible state.
- OpenAPI and `apps/web/src/api/generated/schema.ts` are regenerated for DTO changes.
- `$agent-browser` validates opening a large thread, expanding deferred command output/file diff/image/collaboration examples when available, loading older history, retrying a failed detail/history load when practical, and scrolling without overlap or blank rows.

### 4. Composer Send Acceptance And Routing

Scope: `apps/gateway/src/routes/turns.rs`, `apps/gateway/src/turn_lifecycle.rs`, `apps/gateway/src/queue.rs`, `apps/gateway/src/thread_view.rs`, `apps/gateway/src/store.rs`, `apps/web/src/composer/useComposerOrchestration.ts`, timeline reducer tests, queue tests, and generated OpenAPI.

Work:

- Separate "input accepted by gateway" from "turn started by app-server" in the public response model.
- Add a client request id to composer submissions so pending rows, retries, app-server confirmations, and failures can reconcile deterministically.
- Record a gateway-owned pending user input row before slow app-server work when another browser tab should see the send.
- Clear the composer and render the pending user row after gateway acceptance, not after the canonical app-server user message appears.
- Make pending, failed, queued, and confirmed states visually and accessibly distinct. Pending state must not use the same presentation as a confirmed app-server user message without status text.
- Replace unconditional `refreshed_active_turn_id` on every `/input` with a tiered routing strategy:
  - trust `ThreadViewStore`/runtime state when it is fresh and authoritative,
  - use gateway queue state for pending submitted input,
  - fall back to app-server readback only when state is unknown, stale, or contradictory.
- When app-server readback is needed, prefer summary/status reads over `thread/read includeTurns:true`; only read full turns when there is no safe alternative.
- Add a combined draft-thread first-send path so the frontend does not pay one browser round trip for thread creation and another for submit. The path may be a new endpoint or a gateway wrapper around create-plus-input, but the first visible user message should appear immediately as pending.
- Define failure semantics:
  - app-server turn-start failure marks the pending row failed and keeps retry data,
  - upload failure keeps attachment recovery clear and does not leave a misleading confirmed row,
  - active-turn race queues or steers according to the gateway's authoritative decision,
  - a stale tab cannot silently overwrite newer thread settings.
- Define user controls for failure and ambiguity before implementation: retry, edit/restore draft, cancel/remove pending row, or a documented reason why a state is not user-cancellable.

Exit criteria:

- Backend tests cover idle submit, active submit, stale active state, not-yet-materialized thread submit, app-server failure, and duplicate client request id handling.
- Frontend tests prove text and image sends clear the composer quickly, show pending/failed/confirmed states, and do not duplicate when app-server events arrive.
- Frontend accessibility tests or DOM assertions prove pending and failed status text is exposed to assistive technology.
- Same-user two-tab tests prove pending sends and queued rows converge through gateway state/SSE without reload.
- Generated OpenAPI and frontend types are updated for response/request changes.
- `$agent-browser` validates draft send and existing-thread send on desktop and narrow/mobile shapes.

### 5. Static Asset Delivery And Cold Load

Scope: `apps/gateway/src/static_assets.rs`, `apps/gateway/src/api.rs`, `apps/web/vite.config.ts`, `apps/web/index.html`, PWA/service-worker behavior if touched, and static serving tests.

Work:

- Serve hashed Vite assets with long-lived immutable cache headers.
- Serve `index.html`, manifest, and service-worker files with conservative cache headers that do not trap stale app shells.
- Add compression for JS, CSS, HTML, JSON, and SVG responses, or serve precompressed Vite artifacts if that fits the existing gateway stack better.
- Consider explicit chunk splitting only after measuring parse/evaluate cost. Do not split purely to quiet Vite warnings.
- Verify `EventSource` and API responses are not broken by compression/cache middleware.
- Validate update behavior with the PWA/service-worker path: a new build must not leave the browser running stale JS against a newer gateway API contract.
- Document remote/trusted-VPN deployment implications and recommended fronting proxy settings if users terminate HTTPS or compression outside the gateway.

Exit criteria:

- Static route tests verify cache-control differences between hashed assets and `index.html`.
- A hard refresh shows compressed transfer for JS/CSS and cache hits for repeat loads.
- `GET /v1/events` SSE behavior remains uncompressed or otherwise browser-compatible.
- A simulated or real build replacement proves reload/reopen picks up the new app shell and does not persist an old generated API client after the gateway contract changes.
- `cd apps/web && npm run build` still passes.
- `$agent-browser` validates first load and reload with DevTools/network evidence or equivalent request headers.

### 6. Browser Render Work And Timeline Scheduling

Scope: `apps/web/src/App.tsx`, `apps/web/src/timeline/derive.ts`, `apps/web/src/timeline/TimelineView.tsx`, `apps/web/src/timeline/renderers.tsx`, `apps/web/src/threads/WorkspaceSidebar.tsx`, and focused render/performance tests.

Work:

- Profile React commits after Milestones 2-4 to identify remaining render bottlenecks instead of guessing.
- Keep `App.tsx` as shell coordinator; extract new performance-sensitive behavior into domain hooks or helpers rather than growing the shell.
- Memoize or cache timeline derivation only where profiling shows repeated work for unchanged state.
- Ensure large markdown, diff, command-output, and collaboration renderers do not perform expensive parsing or layout work before their rows are visible or expanded.
- Use React transition/deferred rendering only for non-critical work; input and send affordances must stay responsive.
- Keep responsive/touch behavior correct:
  - desktop fine pointer,
  - narrow fine pointer,
  - narrow touch/mobile.

Exit criteria:

- Render-count or profiling tests protect any new memoization boundary.
- Long-thread open and scroll profiles show no new long tasks attributable to timeline rendering.
- Existing timeline virtualization, ready-state, renderer, and shell tests still pass.
- `$agent-browser` captures desktop and mobile/narrow screenshots or interaction traces showing no overlap, blank rows, or broken composer controls.

### 7. Verification, Rollout, And Documentation

Scope: full affected backend/frontend checks, generated artifacts, README/AGENTS updates if behavior or workflow changes, and this plan/index.

Work:

- Regenerate OpenAPI and frontend schema after every public DTO or route change:
  - run gateway,
  - inspect `GET /openapi.json`,
  - `cd apps/web && npm run generate:api`.
- Run focused tests per milestone before broad checks.
- Run broader checks before marking the overhaul complete:
  - `cargo fmt`
  - `cargo test -p kodex-gateway`
  - `cd apps/web && npm test`
  - `cd apps/web && npm run build`
  - `cd apps/web && npm run test:e2e` when browser-observable behavior changes are complete.
- Use `$agent-browser` for production-bundle validation:
  - hard load direct thread URL,
  - open busy sidebar project,
  - open large thread,
  - send draft chat,
  - send into existing idle thread,
  - send while active so queue behavior is visible,
  - reload with two tabs open and verify convergence.
- Update `README.md` if setup, proxy, cache, compression, profiling commands, or remote deployment guidance changes.
- Update `AGENTS.md` only if contributor workflow or performance guardrails change.
- Update `plans/index.md` when this plan moves from `Proposed` to `Active` or `Complete`.

Exit criteria:

- Every milestone has before/after measurements attached in implementation notes.
- No major independent review findings remain.
- Tests, generated artifacts, docs, and browser validation are all complete.

## Verification

Planning-time verification:

- Inspected existing performance plans listed in the Context section.
- Inspected frontend startup, selected timeline, composer orchestration, event stream, timeline reducer, and static serving paths.
- Inspected gateway sidebar, selected-thread, submit, app-server adapter, event, thread view, and static asset paths.
- Used prior profiling results from this conversation as the initial baseline.

Implementation verification is milestone-specific and must include focused tests, generated API checks when DTOs change, and `$agent-browser` validation for browser-observable behavior.

## Implementation Notes

Initial active pass:

- Milestone 1: added structured `kodex.performance` logs for app-server RPC duration/response bytes/outcome and hot gateway route duration/status, plus a repeatable `apps/gateway/scripts/profile-hot-paths.sh` curl profiler.
- Milestone 1 follow-up: expanded the curl profiler into a JSON summary that includes all hot-route slots, explicit skipped-measurement reasons for routes needing caller-provided bodies/cursors, and a warning that HTTP-only profiling must be paired with browser UX checks.
- Milestone 2: made sidebar project thread groups fetch with bounded concurrency, ran chat and pinned sections in parallel with projects, added a short-lived chat cwd candidate cache with explicit chat-create invalidation, and added a backend concurrency regression test.
- Milestone 3: added a visible older-history boundary/control in the timeline so omitted historical ranges are user-visible. The implicit `startReached` load trigger was removed after full-suite testing showed it could double-submit alongside the explicit control.
- Milestone 4: submit routing now trusts gateway runtime state for known idle/active threads and avoids the unconditional app-server `thread/read` readback on those paths. Same-thread submit routing is guarded by a per-thread input lock; the gateway records a `starting` runtime state before `turn/start` so concurrent or rapid follow-up submits queue instead of starting duplicate turns.
- Milestone 4 follow-up: queue drain idle checks now also treat `starting`, `active`, `streaming`, and `syncing` runtime states as non-idle, preventing queued follow-up input from draining while the first `turn/start` is still in flight.
- Milestone 4 follow-up: failed `turn/start` now retriggers queue drain after returning runtime state to idle, so a follow-up input that queued while the first start was in flight does not remain stuck.
- Milestone 4 review fix: direct `/input` routing now treats `draining` runtime state as non-idle, so browser input queues behind a queue-drainer claim instead of racing a second `turn/start`.
- Milestone 4 frontend pass: composer submission now clears the loading spinner after gateway acceptance rather than waiting for the canonical app-server user message to materialize; transcript rendering still waits for gateway canonical projection events.
- Milestone 5: gateway static serving now applies immutable cache headers to hashed Vite assets, including all-letter Vite/Rollup hash segments, and conservative cache headers to `index.html`, SPA fallback, manifest, service-worker, and unhashed assets.
- Milestone 5 follow-up: gateway HTTP compression is enabled for regular responses, with tests proving gzip on a cacheable static JS asset and no compression on SSE.

## Risks And Open Questions

- Gateway-owned pending input changes the send lifecycle contract. The implementation must be careful not to create a second durable transcript source or duplicate user rows after app-server confirmation.
- Compact timeline DTOs can improve payload size substantially, but they touch many renderers. The first pass should cover the highest-byte item kinds instead of rewriting every item variant at once.
- Sidebar in-memory caching can make repeated loads fast but creates stale-state risk. Prefer bounded concurrency and cwd caching first; add snapshot caching only with invalidation tests.
- App-server schemas include `thread/turns/items/list`, but existing plans note it is reserved or unsupported. Do not build on it unless upstream documentation changes.
- Remote latency cannot be eliminated by local code. The overhaul should minimize avoidable round trips and make accepted user actions visible immediately.
