# Streaming And Generated UI Performance Plan

## Status

Active.

## Goal

Address the first two follow-up priorities from the June 5, 2026 profiling pass:

1. Streaming plus multi-pane update pressure.
2. Generated UI bridge and sandbox errors.

The work should run as a fix, benchmark, evaluate loop. Each candidate fix gets a narrow hypothesis, a regression test where practical, focused verification, mock-profile repeats, and then real-gateway validation only when the candidate is likely worth keeping. Candidates that do not produce measured improvement or reduce errors are backed out before moving on.

## Baseline Evidence

The real-gateway profile was run against the production frontend served by the local gateway on `127.0.0.1:8787`. The gateway reported app-server schema `0.135.0` while the detected binary was `0.137.0`; treat that as a compatibility risk to check before attributing every app-surface issue to frontend code.

Real-gateway baseline:

| Scenario | Duration / observation | Task | Script | Heap | Long task | Notes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `real-desktop-stream-smoke` | 12920 ms | 2254 ms | 1301 ms | 28.1 MB | none material | 1 pane, 1948 timeline mutations |
| `real-desktop-stream-two-pane` | 14202 ms | 4122 ms | 2514 ms | 55.9 MB | max 106 ms | 2 panes, 2638 timeline mutations |
| `real-generated-ui-toggle` | n/a | 622 ms | 351 ms | n/a | n/a | 7 console/page errors |

Trace summaries:

- `real-desktop-stream-two-pane`: `FunctionCall` dominated at about `2326 ms` across `8553` calls, with `EventDispatch` at `485 ms`, `RunMicrotasks` at `333 ms`, layout plus paint under `340 ms`.
- `real-desktop-stream-smoke`: `FunctionCall` was about `665 ms`, so the second pane adds far more script work than layout work.
- `real-generated-ui-toggle`: errors included a sandboxed `localStorage` page error, unsupported `navigate-to` CSP warnings, and JSON-RPC parse/shape errors from the app-surface iframe path.

Expected UX lift:

| Priority | Expected lift | Why |
| --- | --- | --- |
| Streaming/multi-pane update pressure | High for active real-gateway turns with more than one pane open. Target is visibly smoother streaming, fewer long tasks, and less typing contention while a turn streams. | The two-pane stream added about `1869 ms` of task time and `1213 ms` of script time over the one-pane stream, mostly in JS calls rather than layout. |
| Generated UI bridge/sandbox errors | Medium UX lift, high correctness lift. Target is a console-clean generated UI/app-surface open path and fewer broken third-party MCP app surfaces. | Current errors are user-visible when an iframe fails or bridge calls reject, even if the raw task time is not the largest hotspot. |

## Current Grounding

Streaming and panes:

- `apps/web/scripts/profile-dockview.mjs` and `apps/web/scripts/profile-real-gateway.mjs` already provide mock and real profile scenarios with `--only` filters.
- `apps/web/src/timeline/useTimelineEventQueue.ts` batches selected/read-only timeline updates with `requestAnimationFrame`.
- `apps/web/src/timeline/batch.ts` coalesces `thread_view.item_delta`, `row_delta`, and compatible turn patches.
- At baseline, `apps/web/src/panes/thread/ThreadPane.tsx` had its own `ExistingThreadPane` timeline path that subscribed to `WorkspaceProvider.subscribeLiveEvent` and called `setTimeline` once per canonical render event, bypassing the shared timeline queue and batch coalescer.
- `apps/web/src/workspace/WorkspaceProvider.tsx` opens one global stream for `workspaceSubscribedThreadIds(workspace.panes)` and fans every event through every registered pane handler. Each pane then filters by thread id.
- Candidate A now routes `ExistingThreadPane` render events through the shared queue/coalescer instead of applying every event directly. Real-gateway profiling did not prove a large UX lift, so deeper row/render attribution remains the next streaming follow-up.

Generated UI and app surfaces:

- At baseline, `apps/web/src/generatedUi/themeDocument.ts` injected a CSP that included unsupported `navigate-to 'none'`; that directive has been removed.
- `GeneratedUiPane` and `AppSurfacePane` still render `sandbox="allow-scripts"` iframes without `allow-same-origin`; profiler init scripts now avoid touching iframe `localStorage`, and the tested real MCP app no longer reports a storage page error.
- `apps/web/src/appSurfaces/AppSurfacePane.tsx` now normalizes outbound JSON-RPC result/params objects and strips top-level `_meta: null`; the tested real MCP app no longer reports JSON-RPC parse errors.
- `plugins/kodex-control/skills/generative-ui/SKILL.md` documents agent-facing generated UI behavior. If the bridge contract or recommended helper changes, update this guidance and bump the plugin cachebuster as required by `AGENTS.md`.

## Non-Goals

- Do not revisit composer typing optimizations in this plan except as an observed secondary metric while streaming.
- Do not change the gateway canonical timeline contract unless frontend fixes fail and the trace shows remaining wire/patch-size pressure.
- Do not add WebSockets or replace SSE.
- Do not make iframe documents same-origin as a shortcut for storage errors. Keep the sandbox boundary unless a separate security plan changes it.
- Do not preserve a candidate fix just because it is plausible. Keep only measured wins or correctness fixes.

## Hillclimb Loop

For every candidate:

1. Record the hypothesis, files touched, and expected metric movement.
2. Add a failing focused test where practical. For pure profiling-only candidates, add instrumentation or a deterministic mock profile assertion instead.
3. Implement the smallest viable fix.
4. Run focused tests and `npm run build`.
5. Run the relevant mock profiler at least three times and compare medians against the current baseline.
6. Run the relevant real-gateway profiler when the mock result is a likely keeper.
7. Keep the candidate only if it improves the target metric, removes a correctness error, or is required for the next measured candidate. Otherwise revert it before testing the next hypothesis.

Scorecard:

| Candidate | Mock profile delta | Real profile delta | Errors delta | Decision | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| Streaming A: batched Dockview pane updates | Noisy; deterministic test proves `3` same-frame render events reduce through `1` reducer batch | Initial real run looked better, but final comparable run did not prove task/script improvement: baseline `4122.1 ms` task over `2638` mutations; final `4410.4 ms` task over `2547` mutations | n/a | Kept, limited | Keeps Dockview panes on the shared queued/coalesced timeline path and avoids per-event state updates, but expected UX lift is low/uncertain from real profiles. |
| Streaming B: keyed live-event fanout | n/a | `real-desktop-stream-two-pane` after B: `4250.8 ms` task over `2250` mutations | n/a | Reverted | It did not materially improve the live two-pane profile, so the added subscription complexity was backed out. |
| Streaming C: render/context isolation | n/a | n/a | n/a | Deferred | The final traces still point at high JS work under real model-output variance, but this pass did not isolate a safe component-level render fix. |
| Streaming D: adaptive flush cadence | n/a | n/a | n/a | Deferred | Avoided freshness tradeoffs until trace evidence shows batching cadence, not row/render work, is the dominant remaining cause. |
| Generated UI A: CSP cleanup | n/a | `real-generated-ui-toggle` no longer reports unsupported `navigate-to` warnings | Warning removed | Kept | Removed only unsupported CSP noise; deny-by-default directives and iframe sandbox remain. |
| Generated UI B: storage guard | Mock generated-UI profile clean after top-frame profiler guard | Real profile storage pageerror removed after real profiler top-frame guard | Storage pageerror removed | Replaced | A runtime storage shim was tested and rejected because the observed error came from profile init scripts touching sandboxed iframes, not from the app document. |
| Generated UI C: bridge normalization | Focused app-surface tests pass | Real profile JSON-RPC parse errors removed | JSON-RPC errors removed | Kept | Outbound MCP notifications/results now use object-shaped params/results and omit top-level `_meta: null`. |

Implementation evidence from June 5, 2026:

- Focused streaming regressions: `cd apps/web && npm test -- --run src/App.mvp.timeline.test.tsx -t "batches active Dockview pane|keeps applying later Dockview pane patches"` passed.
- Generated UI/app-surface focused suite: `cd apps/web && npm test -- --run src/generatedUi/themeDocument.test.ts src/generatedUi/GeneratedUiPane.test.tsx src/appSurfaces/AppSurfacePane.test.tsx src/App.generatedUi.test.tsx` passed.
- Production build: `cd apps/web && npm run build` passed.
- Diff hygiene: `git diff --check` passed.
- Final real streaming report after Candidate A and review fix: `tmp/real-gateway-profiling/2026-06-05T19-51-44-408Z/report.md`.
- Reverted Candidate B real streaming report: `tmp/real-gateway-profiling/2026-06-05T19-56-41-885Z/report.md`.
- Final real generated UI report: `tmp/real-gateway-profiling/2026-06-05T19-37-00-323Z/report.md`.
- Final mock generated UI report: `tmp/dockview-profiling/2026-06-05T19-35-55-130Z/report.md`.
- Agent-browser validation opened the real `get-budget-data` app surface in desktop and mobile-emulated sessions; both rendered one iframe with the Budget Allocator controls and no visible alert banners. Agent-browser screenshot capture was skipped after the CLI daemon returned `Resource temporarily unavailable`.
- `cd apps/web && npm test -- --run src/App.mvp.timeline.test.tsx` still has five pre-existing failures in this dirty worktree; the new batching regression passes in isolation.

Streaming outcome:

- The kept frontend batching change fixes a real implementation mismatch: Dockview panes no longer bypass the shared timeline queue/coalescer.
- The final real-gateway profile does not support claiming a large streaming UX win. Earlier favorable numbers were confounded by a much shorter model response.
- The remaining priority is a deeper streaming-render hot-path pass with length-normalized profiling, React render attribution, and row/component isolation before changing cadence or gateway contracts.

Primary streaming success criteria:

- Reduce `real-desktop-stream-two-pane` task and script medians by at least `25%`, or recover at least half of the measured two-pane overhead over the one-pane stream.
- Keep max long task no worse than baseline plus `10%`.
- Keep heap no worse than baseline plus `10%` unless the change is otherwise clearly better and the heap increase is understood.
- Preserve visible streaming cadence; do not make output feel stuck by batching too aggressively.

Generated UI success criteria:

- `real-generated-ui-toggle` has zero console warnings/errors/page errors attributable to CSP, sandbox storage, or JSON-RPC bridge shape.
- Existing generated UI submit behavior still works.
- MCP app-surface bridge tests still prove JSON-RPC requests, notifications, tool input/result notifications, and legacy generated submit aliases behave correctly.

## Milestones

### 1. Stabilize Benchmark Inputs And Reporting

Scope:

- `apps/web/scripts/profile-dockview.mjs`
- `apps/web/scripts/profile-real-gateway.mjs`
- `apps/web/package.json`
- `tmp/dockview-profiling/` and `tmp/real-gateway-profiling/` generated artifacts only

Work:

- Confirm the current profiler scripts can run individual scenarios with `--only`.
- Add or tighten summary output if needed so each run reports:
  - total task duration,
  - script duration,
  - long task count and max duration,
  - heap,
  - timeline mutation count,
  - pane count,
  - console/page errors,
  - trace top-level event summary.
- Add a repeat mode if the implementation needs medians and the current manual repeat workflow is too error-prone.
- Keep generated profile artifacts ignored; capture baseline numbers in implementation notes or plan completion evidence.
- Before using real gateway results as final evidence, verify whether the app-server schema mismatch still exists and whether it affects app-surface behavior.

Exit criteria:

- `cd apps/web && npm run profile:dockview -- --skip-build --only desktop-stream-heavy,desktop-mixed-panes`
- `cd apps/web && npm run profile:real-gateway -- --only real-desktop-stream-smoke,real-desktop-stream-two-pane,real-generated-ui-toggle`
- The report is sufficient to make a keep/revert decision for each candidate without manually opening Chrome traces for every run.

### 2. Streaming Candidate A: Batch Dockview Thread Pane Live Updates

Hypothesis:

The largest two-pane streaming cost comes from `ExistingThreadPane` applying each live event directly through `setTimeline`, bypassing `useTimelineEventQueue` and `coalesceTimelineEventBatch`. Batching this path should reduce `FunctionCall`, `EventDispatch`, and React render churn without changing gateway-owned timeline truth.

Scope:

- `apps/web/src/panes/thread/ThreadPane.tsx`
- `apps/web/src/timeline/useTimelineEventQueue.ts`
- `apps/web/src/timeline/batch.ts`
- focused tests under `apps/web/src/App.mvp.timeline.test.tsx`, `apps/web/src/timeline/batch.test.ts`, or a new thread-pane-focused test

Work:

- Start with a failing regression test that emits a burst of same-thread `thread_view.item_delta` and `thread_view.patch` events through the workspace stream and proves the Dockview thread pane reduces them through one queued batch instead of one state update per event.
- Reuse `useTimelineEventQueue` and `applyTimelineEventBatch` in `ExistingThreadPane`, or extract a small shared hook if that keeps selected, read-only, and Dockview pane behavior aligned.
- Preserve the existing refresh behavior for `thread_view.refresh_required`, metadata updates, notifications, pins, and rename events.
- Avoid calling `setEntry({ phase: "streamingLive", threadId })` for every event when the pane is already in that phase.
- Keep same-thread convergence behavior. The browser still renders only gateway canonical snapshots, `thread_view.patch`, and `thread_view.item_delta`.

Benchmark gate:

- Run mock `desktop-stream-heavy`, `desktop-mixed-panes`, and `desktop-four-thread-panes` three times.
- If mock results improve or stay neutral, run real `real-desktop-stream-smoke` and `real-desktop-stream-two-pane`.
- Keep if the two-pane streaming script/task medians improve materially and visible streaming remains smooth.

Exit criteria:

- Focused frontend tests pass.
- `cd apps/web && npm run build` passes.
- The real two-pane stream no longer shows a large per-event direct-update signature from the Dockview pane path.

### 3. Streaming Candidate B: Key Live Event Fanout By Thread

Hypothesis:

After batching, remaining overhead may come from `WorkspaceProvider` broadcasting every subscribed-thread event to every pane handler, producing `O(panes * events)` JS calls. Dispatching to handlers by `threadId` should reduce function calls in multi-pane layouts without changing SSE semantics.

Scope:

- `apps/web/src/workspace/WorkspaceProvider.tsx`
- `apps/web/src/workspace/resourceSubscriptions.ts`
- `apps/web/src/panes/thread/ThreadPane.tsx`
- `apps/web/src/workspace/WorkspaceProvider.test.tsx`
- app-level timeline/workspace tests

Work:

- Add a keyed subscription API such as `subscribeThreadLiveEvent(threadId, handler)` while preserving a narrow global subscription path for truly global events.
- Route events with `event.threadId` directly to matching thread handlers.
- Keep global operational events available to app-level handlers for sidebar, notifications, queue state, pins, automations, MCP, account/rate-limit, and other non-pane state.
- Add tests proving:
  - a four-pane workspace does not invoke handlers for unrelated thread ids,
  - global events still reach global handlers,
  - switching a pane target unsubscribes the old thread id,
  - duplicate panes for the same thread both receive matching events,
  - two-tab convergence still relies on gateway state and SSE, not local pane-only state.

Benchmark gate:

- Run mock `desktop-four-thread-panes`, `desktop-mixed-panes`, and `desktop-stream-heavy`.
- Run real two-pane stream if mock multi-pane function-call count drops.
- Keep only if it adds measurable improvement after Candidate A or materially simplifies the event path without regressions.

### 4. Streaming Candidate C: Render And Context Isolation

Hypothesis:

If task time remains high after event batching and keyed fanout, React render fanout may be caused by broad `WorkspaceContext` value changes, unstable render props, or heavy timeline rows re-rendering when only the active row changes.

Scope:

- `apps/web/src/workspace/WorkspaceProvider.tsx`
- `apps/web/src/workspace/*`
- `apps/web/src/panes/thread/ThreadPane.tsx`
- `apps/web/src/timeline/TimelineView.tsx`
- `apps/web/src/timeline/renderers.tsx`
- closest focused tests

Work:

- Use React profiler data or Chrome trace evidence before editing.
- Consider splitting live-event subscription functions from broad workspace state context if context changes are forcing pane subtree renders.
- Memoize or selector-isolate only the components shown by profiler evidence.
- Check small hot spots such as `approvals.filter((approval) => approval.threadId === threadId)` on every streaming render only if profiler data shows they matter.
- Do not introduce a new state framework just for this pass.

Benchmark gate:

- Run mock multi-pane stream scenarios and compare render/FunctionCall metrics.
- Keep only measured improvements. If trace evidence does not point to React context/render fanout after Candidate A/B, skip this milestone.

### 5. Streaming Candidate D: Adaptive Flush Cadence

Hypothesis:

If reducer/render work is still high after eliminating direct per-event updates and broad fanout, the shared `requestAnimationFrame` flush cadence may still be too frequent for high-rate model output in multi-pane layouts.

Scope:

- `apps/web/src/timeline/useTimelineEventQueue.ts`
- `apps/web/src/timeline/batch.ts`
- `apps/web/src/timeline/useSelectedThreadTimeline.ts`
- `apps/web/src/timeline/useReadonlyThreadTimeline.ts`
- `apps/web/src/panes/thread/ThreadPane.tsx`

Work:

- Add a configurable/adaptive queue policy:
  - normal cadence for low event rates,
  - a slightly longer coalescing window during bursts,
  - max latency guard so visible text does not appear stuck.
- Add tests with fake timers proving flush timing, cancellation, unmount cleanup, and burst coalescing.
- Use this only after Candidates A-C because it trades update freshness for lower work.

Benchmark gate:

- Compare streaming smoothness, task/script medians, and max output latency.
- Keep only if it improves the measured two-pane stream without making text visibly laggy.

### 6. Generated UI Candidate A: Remove Unsupported CSP Noise

Hypothesis:

The `navigate-to 'none'` directive is unsupported in the current Chromium profile and creates warning noise. Removing it from the injected meta CSP should reduce false-positive console issues without weakening the iframe sandbox in a meaningful way.

Scope:

- `apps/web/src/generatedUi/themeDocument.ts`
- `apps/web/src/generatedUi/themeDocument.test.ts`

Work:

- Remove `navigate-to 'none'` from `GENERATED_UI_DOCUMENT_CSP` and dynamic CSP generation.
- Keep `form-action 'none'`, `frame-src 'none'`, `base-uri 'none'`, `connect-src` restrictions, and iframe sandboxing.
- Add/update tests so the intended CSP remains explicit.

Benchmark gate:

- Run generated UI tests and `real-generated-ui-toggle`.
- Keep if the unsupported-CSP warning disappears and no new navigation capability is introduced.

### 7. Generated UI Candidate B: Guard Opaque-Origin Storage Access

Hypothesis:

Some generated or MCP app documents probe `localStorage` during startup. In an `allow-scripts` opaque-origin iframe, that can throw and break the app. A small injected storage guard or in-memory shim should improve compatibility while preserving the no-same-origin sandbox.

Scope:

- `apps/web/src/generatedUi/themeDocument.ts`
- `apps/web/src/generatedUi/themeDocument.test.ts`
- possibly `apps/web/src/appSurfaces/AppSurfacePane.test.tsx` if the app-surface path needs explicit coverage

Work:

- Inject the guard before user/app scripts by keeping the head injection at the start of the document head.
- Prefer a defensive shim only when reading `window.localStorage` or `window.sessionStorage` would throw.
- The shim should be in-memory, per iframe load, and should not persist or expose gateway origin storage.
- Add tests proving the injected document contains the guard before author-provided head scripts.
- Browser-validate against real `real-generated-ui-toggle`, because JSDOM may not reproduce opaque-origin behavior.

Benchmark gate:

- Keep if the storage page error disappears without adding `allow-same-origin`.

### 8. Generated UI Candidate C: Normalize App-Surface Bridge Messages

Hypothesis:

The app-surface host and iframe are exchanging or receiving JSON-RPC shapes that some app runtimes reject. A single parser/normalizer should prevent malformed requests from reaching the gateway and prevent malformed responses from being posted back to the iframe.

Scope:

- `apps/web/src/appSurfaces/AppSurfacePane.tsx`
- possibly new `apps/web/src/appSurfaces/bridge.ts`
- `apps/web/src/appSurfaces/AppSurfacePane.test.tsx`
- `apps/web/src/generatedUi/GeneratedUiPane.tsx`
- `apps/web/src/generatedUi/GeneratedUiPane.test.tsx`
- `apps/web/src/App.generatedUi.test.tsx`
- `plugins/kodex-control/skills/generative-ui/SKILL.md` only if the public helper contract changes

Work:

- Extract JSON-RPC validation and response construction into a focused helper.
- Accept only valid app requests/notifications from the active iframe `contentWindow`.
- Treat response-shaped messages from the iframe as ignored unless the host has a real pending host-originated request that expects them.
- Send JSON-RPC responses with exactly one of `result` or `error`.
- Preserve legacy generated UI submit aliases until the MCP app-surface migration intentionally removes them.
- Ensure malformed or unknown messages do not create unhandled page errors. If a reply is useful, reply with a structured bridge error only to the active iframe.
- Add tests for malformed messages observed in the real profile:
  - response without `method`,
  - `params._meta` set to `null` when a method expects an object,
  - both `result` and `error` omitted,
  - unknown `kodex.*` submit aliases,
  - stale `sessionId` or `revision`.

Benchmark gate:

- Run generated UI/app-surface tests.
- Run `real-generated-ui-toggle`.
- Keep when JSON-RPC parse errors are gone and valid bridge calls still reach `onBridgeRequest`.

### 9. Final Real-Gateway Evaluation And Documentation

Scope:

- this plan
- `plans/index.md`
- benchmark artifacts under `tmp/`
- implementation notes in the final PR/commit message

Work:

- Rerun the real-gateway scenarios after the best candidate set is applied:
  - `real-desktop-stream-smoke`
  - `real-desktop-stream-two-pane`
  - `real-generated-ui-toggle`
  - optionally `real-desktop-composer-typing` as a secondary regression check while streaming work is fresh
- Rerun mock scenarios for deterministic comparison:
  - `desktop-stream-heavy`
  - `desktop-mixed-panes`
  - `desktop-four-thread-panes`
  - `desktop-pane-ops`
  - `mobile-generated-ui-toggle`
- Use `$agent-browser` against the local app for a human-visible validation pass:
  - desktop two-pane active stream,
  - desktop generated UI/app-surface open,
  - narrow/mobile generated UI/app-surface open,
  - console and page error inspection.
- Update the scorecard with kept/reverted candidates and final deltas.
- Mark this plan Active when implementation starts and Complete only when benchmarks, tests, docs, and review pass.

Exit criteria:

- Streaming priority has either met the target reduction or the remaining bottleneck is documented with trace evidence and a new follow-up plan.
- Generated UI/app-surface toggle is console-clean for the targeted error classes.
- Focused tests and production build pass.
- A review pass checks that timeline ownership still follows `AGENTS.md`: the gateway remains the source of truth and browser state is only a projection.

## Verification Matrix

Focused tests:

- `cd apps/web && npm test -- --run src/timeline/batch.test.ts`
- `cd apps/web && npm test -- --run src/App.mvp.timeline.test.tsx`
- `cd apps/web && npm test -- --run src/workspace/WorkspaceProvider.test.tsx`
- `cd apps/web && npm test -- --run src/generatedUi/themeDocument.test.ts src/generatedUi/GeneratedUiPane.test.tsx src/appSurfaces/AppSurfacePane.test.tsx src/App.generatedUi.test.tsx`

Build:

- `cd apps/web && npm run build`

Mock profiles:

- `cd apps/web && npm run profile:dockview -- --skip-build --only desktop-stream-heavy,desktop-mixed-panes,desktop-four-thread-panes`
- `cd apps/web && npm run profile:dockview -- --skip-build --only desktop-pane-ops,mobile-generated-ui-toggle`

Real-gateway profiles:

- `cd apps/web && npm run profile:real-gateway -- --only real-desktop-stream-smoke,real-desktop-stream-two-pane`
- `cd apps/web && npm run profile:real-gateway -- --only real-generated-ui-toggle`

Manual/browser validation:

- Use `$agent-browser` for desktop and narrow/mobile validation after tests and profiles pass.
- Capture console/page errors during generated UI/app-surface open.
- Confirm streaming output remains visibly incremental and same-thread state converges after reload or second-tab observation if stream routing changes.

## Risks And Open Questions

- Real model/gateway profiles are variable. Use mock profiles for candidate comparisons and real gateway for final validation.
- If the app-server schema mismatch remains, app-surface bridge errors may include upstream compatibility issues. Verify before overfitting frontend parsing to a transient mismatch.
- Batching can hide updates if tuned too aggressively. Keep visible streaming cadence as a first-class acceptance criterion.
- Keyed fanout must not drop selected-thread operational events that update sidebar, read state, approvals, queue, or app-surface state.
- If `plugins/kodex-control` guidance changes, update the plugin cachebuster before reinstalling or validating the plugin.
- If frontend-only fixes reduce task time but real profiles still show huge patch bytes, open a separate backend contract plan rather than expanding this plan midstream.
