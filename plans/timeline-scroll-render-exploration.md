# Timeline Scroll and Render Exploration

## Status and objective

Complete as an implementation exploration on 2026-10-09. The retained changes are committed through `b11392e`; deployment remains separate and has not been requested.

Make thread scrolling predictable through streaming, history loading, disclosures, completion, pane resizing and composer changes. Reduce maintained scroll machinery and unnecessary render work. Explore a small replacement of the current scroll adapter around Virtuoso before considering a library change.

The deliverable is a tested, reviewable recommendation and retained implementation, supported by matched videos and performance findings. Keeping an existing behavior or rejecting an experiment is a valid outcome. The current scroll/pacing implementation is a starting point, not a constraint to preserve. A few milliseconds of additional presentation latency are acceptable only when they buy a demonstrated benefit; canonical state and actionable controls must not be delayed.

## Boundaries

- Keep canonical gateway snapshots, patches and text deltas authoritative. Do not change native lifecycle, history pagination semantics, submission routing or cross-client reconciliation to solve presentation problems.
- Scroll, disclosure and focus state belong locally to each pane. Preserve independent reading positions across panes and tabs; do not synchronize scroll state through the gateway.
- Prefer one geometry owner and a small following/reading policy. Reuse installed Virtuoso capabilities where they satisfy the actual scenarios. Do not assume enabling `followOutput` handles existing-row growth, external content, resize and consolidation correctly without testing.
- No custom virtualizer, nested virtualizers, global scheduler, second transcript, hidden measurement tree, generic layout cache, persistent presentation ledger, ID aliases or broad state-store rewrite. No new dependency unless the existing library demonstrably cannot satisfy the bounded requirements; document that result before widening scope.
- Remove superseded scroll paths, timers and rejected experiment switches. Do not layer compensating observers or another anchoring engine over the old adapter.
- Preserve streaming text quality, accessibility, text selection, native disclosure semantics, composer editing continuity, responsive ownership and reduced motion. Avoid whole-list animation and height tweening to conceal incorrect anchoring.
- No deployment under this plan. A separate explicit deployment request is required.

## Starting evidence

Recheck the checkout when execution starts. Source findings are hypotheses about runtime impact unless stated otherwise.

| Finding | Evidence and implication |
| --- | --- |
| Lost follow after viewport resize | Bundled-Chromium audit left a pinned idle transcript 300 px above bottom after viewport height shrank by 300 px; jump button remained hidden. |
| Lost follow after composer growth | Same audit left a pinned transcript 113 px above bottom after multiline composer growth; jump button remained hidden. |
| Timing-based scroll intent | The adapter uses 500 ms user-intent and 120 ms auto-scroll windows. Input and streaming corrections can interleave; small upward scrolls remain pinned inside a 60 px threshold. Reproduce before assigning frequency/severity. |
| Aggregate prepend restoration | Captured scrollTop plus total scrollHeight growth conflates prepends with streaming, media, controls and estimated-height corrections, and can override navigation during a pending read. |
| Split geometry ownership | External controls/content surround Virtuoso; the conditional sticky jump button participates in layout. List measurements do not cover all changes to the scrolling surface. |
| Disclosure remount state | Worked expansion is pane-owned, but activity open/show-more state resets when virtualized rows unmount. Expanded Worked children all render inside one virtual item. |
| Update cost | Text deltas map loaded rows; TimelineView adds wrapper mapping and pruning scans. List-height notifications enter React state and trigger another render/layout effect. Runtime cost has not been benchmarked. |

Relevant owners: `timeline/TimelineView.tsx`, `timeline/useBottomPinnedVirtuosoTimeline.ts`, `timeline/useTimelineScrollParent.ts`, `timeline/activityRenderers.tsx`, `timeline/reducer.ts`, `panes/thread/ThreadPane.tsx` and `styles/shell.css` under `apps/web/src`.

The initial audit artifacts are `tmp/scroll-audit/probe.mjs` and `probe.json`; they may be absent later and are not required dependencies. They used a development build and are correctness evidence, not a performance baseline. The earlier suspicion of persistent subagent-switch scroll leakage was ruled out by the loading remount; do not treat it as a confirmed defect.

## Iteration rules

Before each experiment, record the symptom, hypothesis, smallest change and success criterion. Compare against both a frozen baseline and the currently retained candidate. Make one meaningful change at a time; inspect normal-speed video and geometry before deciding keep, revise or discard.

Start behavior changes with a failing focused regression when practical. Keep the permanent tests behavioral; do not assert timer values, CSS strings or implementation-specific callback counts. Temporary instrumentation may count those callbacks to diagnose work.

Timebox each prototype to roughly half a day and one or two focused tuning passes. If it requires more tracking, exceptions or timing layers than the code it replaces, simplify or reject it. Stop optimizing once correctness holds and further gains are within run-to-run noise.

Update this plan during execution: stage status, experiment dispositions, evidence, new findings and reordered next steps. Record why priorities changed. Do not silently weaken acceptance criteria or expand scope. Routine candidate selection needs no new approval once execution is authorized.

After each stage, post a concise checkpoint in the conversation: what was tried, the relevant clip/measurements, keep/revise/reject decisions and the next experiment. Surface material surprises sooner. These are progress reports, not additional approval gates.

Each retained implementation chunk gets relevant checks, independent read-only review under AGENTS.md, fixes and a focused commit. Update `plans/index.md` when status changes.

## Stage 1: Reproduce and establish a baseline

Status: Complete.

Freeze the starting commit and production bundle. Reuse canonical fixtures and existing browser helpers; create only a small deterministic replay harness where existing coverage is insufficient. Prove genuine running assistant text and valid canonical patch scopes rather than animating a static snapshot. Keep original production behavior available for matched comparisons.

Capture the two confirmed resize failures first. Then reproduce and rank upward-input races, interrupted return-to-bottom, delayed prepend, disclosure remount, completion consolidation, external approval/debug content changes and hidden-pane recovery. Separate confirmed failures, design decisions and unreproduced risks.

Use variable-height messages, Markdown, delayed media sizing and tool activity. Include short non-overflowing transcripts, ordinary history and a stress history (initial targets: approximately 30, 300 and 1,000 loaded rows), plus one very large expanded turn. Select a few representative cases for repeated performance runs; do not multiply every scenario by every device.

Record frame-by-frame anchor coordinates and bottom distance around each event. For reading, identify a surviving visible item and its intra-item position; distinguish intentional user movement and disappearance of the anchor from unwanted drift. Record restoration time, maximum transient displacement and settled error. CLS or eventual settled position alone is insufficient.

Exit: reproducible baseline clips, a prioritized failure inventory, baseline noise/tolerances and a bounded comparison harness. No performance claims from source inspection alone.

## Stage 2: Establish one scroll owner

Status: Complete.

Write the behavioral contract before selecting an implementation:

- Following keeps the actual content bottom visible after text growth, append, completion, media sizing and viewport/composer changes.
- Deliberate navigation away interrupts following promptly, including small upward input. Reading does not resume merely because layout shrinks or content temporarily fits. Explicit jump or deliberate navigation to the bottom resumes it; define and test any near-bottom tolerance.
- Disclosures and selection can preserve reading without repeated accidental repinning. Opening versus closing and short content need explicit test cases.
- The jump button accurately reflects useful content below the viewport and occupies no transcript layout space.
- Initial entry, hidden-pane recovery and thread replacement have explicit behavior. Never carry pending adjustment work into a different thread or let a hidden zero-size pane corrupt visible geometry.

Prototype a Virtuoso-owned approach first: measured list/header/footer content, library initial placement and supported append/growth/prepend operations, with a thin pane-local policy. Inspect the installed implementation/API where needed. Verify changing an existing row, not only appending rows.

If that approach fails a concrete requirement, compare one minimal adapter alternative using the same tests. It may observe the viewport and necessary content geometry and coalesce imperative corrections, but must be the sole custom scroll writer and use Virtuoso's measurements rather than reconstructing them. Do not retain both candidates in production.

Remove timer-based origin guesses where explicit input handling and known programmatic operations suffice. Scope keyboard intent to the relevant pane, check touch momentum and overlay scrollbars, and make user input cancel a smooth jump. Avoid smooth automatic following; compare an immediate explicit jump with a bounded smooth one, including reduced motion and streaming interruption.

Exit: confirmed resize failures fixed, bottom/button state consistent, reading wins over automatic corrections, and fewer competing scroll paths. Choose the simplest candidate meeting the contract and document its limitations.

## Stage 3: Restore history and interactive content predictably

Status: Complete.

Replace aggregate scrollHeight-delta restoration with the selected owner's supported prepend anchoring. If additional anchoring is necessary, use a stable visible key and offset locally; do not add a second restoration engine. Verify variable estimates, delayed measurement, concurrent output, history exhaustion/failure and user navigation during the request. Pending loads must respect the reader's latest position, not force an old capture back into place.

Define a deterministic fallback when completion, canonical replacement or revert removes the anchor: preserve a surviving neighbor where appropriate, or the final bottom when following. Do not retain obsolete canonical rows just to preserve pixels.

Preserve activity expansion and show-more state across virtualized remounts using the smallest pane-local keyed state already justified by Worked expansion. Bound its lifetime to retained rows/thread identity and clean it up on removal. Check nested disclosure focus and selection behavior; do not build a general presentation cache.

Test whether flattening expanded Worked children into the presentation list improves a measured large-turn problem. Preserve canonical row identity and accessible group/disclosure semantics; this is a presentation projection, not a new authoritative transcript. Compare with existing bounded rendering and reject flattening if the practical benefit does not justify its complexity.

Exit: prepend and automatic restructuring preserve reading within measured tolerance, surviving disclosures retain their state, and large expanded turns have a documented keep/change decision.

## Stage 4: Reduce render and measurement cost

Status: Complete.

Profile the retained correct implementation before further edits. Test the smallest useful candidates:

| Candidate | Decision criterion |
| --- | --- |
| Remove list-height React state | Fewer unnecessary timeline commits without delaying geometry correction or missing external content/viewport changes. |
| Remove redundant row wrapping/pruning scans | Reduce demonstrated work while preserving stable row identity and memoization. Keep ordinary immutable copies unless profiling justifies more. |
| Coalesce geometry reads/writes | Reduce duplicate work without adding visible lag, stale input decisions or continuously running frame loops. |
| Tune the current 720 px overscan | Lower offscreen work without blank flashes during fast wheel/touch scrolling, focus loss or remount regressions. |
| Adjust presentation cadence only if needed | Small additional text latency must yield repeatable work/frame benefits and preserve current text quality. Never buffer lifecycle or actionable controls. |

Do not introduce new indexes, stores or caching solely to turn an O(n) observation into a theoretical improvement. Demonstrate that it matters at realistic history sizes first. Remove instrumentation from production unless it already belongs in supported development tooling.

Exit: every candidate has a disposition, retained gains are measured, and the implementation is smaller or has a concrete justification for any added complexity.

## Stage 5: Integrated validation and polish

Status: Complete.

Run focused unit/component regressions, relevant existing streaming/reading/history/workspace/composer browser tests, build/typecheck and frontend trim. Add browser regressions for the confirmed gaps. Use agent-browser when available with bundled Playwright Chromium; otherwise document its absence and use bundled Chromium directly. Never launch installed Chrome from the gateway.

Cover these interaction families without an exhaustive Cartesian product:

- Wheel, small upward scroll, keyboard, scrollbar dragging, touch/momentum, selection/copy and interrupted explicit jump during real streaming.
- Composer growth/shrink, queue/accessory changes, pane width/height resize, expanded composer and visual viewport/keyboard changes. Check focus, draft and selection continuity.
- Variable-height prepend while idle/streaming, user navigation while loading, delayed media, disclosures, completion consolidation, snapshot/revert and thread replacement.
- Hidden/foreground recovery and adjacent panes with different sizes and independent follow modes. Reuse existing same-user two-tab missed-event convergence coverage and verify that scroll/disclosure choices remain local. Add new canonical convergence cases only if retained changes touch reducer/event behavior; authoritative content converges, while local reading positions need not match.
- Desktop fine pointer, narrow fine pointer, narrow touch, wide touch with compact pane, hybrid input and reduced motion. Browser emulation does not prove physical overlay-scrollbar or mobile-keyboard behavior; report remaining manual gaps.

For timing comparisons, use matched production builds and at least three runs per selected case, alternating baseline/candidate order where useful. Separate video, React profiling and heavily instrumented traces from lighter quantitative runs. Record host, browser, viewport/pane, input mode, throttling, payload, commit, repetitions and spread. Exclude and retain records of contaminated runs; repeat rather than claim gains from host contention.

Report frame intervals/p95, >50 ms tasks, script/layout work, DOM/mount counts, targeted React commits, measurement/scroll-correction frequency and receipt-to-visible latency. Investigate repeatable regressions above roughly 10% in relevant work or frame p95; that threshold triggers investigation, not automatic statistical significance. Structural savings do not prove CPU or battery gains.

Initially target at most 2 px settled error for a surviving anchor or pinned bottom, calibrating against measured fractional-pixel noise. Measure transient drift and time out of tolerance too; no passing result based only on a long settling wait. Distinguish expected measurement delay from repeated oscillation, wrong-direction corrections and lost-follow states. Any tolerance changes require evidence and an explicit plan update.

Do not add layout animations to hide remaining anchor failures. Polish only deliberate transitions after geometry is correct, and retain motion only if normal-speed comparison improves without extra measurement churn. Settled/hidden timelines must have no continuing correction loop.

Exit: integrated regressions pass, performance evidence is usable, independent review issues are resolved and all experimental paths are removed. Unverified device behavior remains labeled; unresolved required checks prevent completion.

## Stage 6: Report, demonstrate and recommend

Status: Complete.

Deliver a concise final recommendation: the chosen geometry owner and follow policy, what was rebuilt/deleted, what remained, rejected alternatives and why, plus any remaining risks. Include a complexity comparison (scroll writers, observers, timers and state responsibilities); line count alone is not a quality metric.

Provide matched baseline/final full-turn recordings and short demonstrations of viewport/composer resizing, scrolling away and returning during streaming, history prepend, disclosure remount and completion. Include a representative narrow-pane and multi-pane demonstration. Show a meaningful rejected alternative only when it explains the decision. Link playable video files directly in the conversation, not only inside a report/comparison page. Keep bulky videos/traces out of Git and identify which build each artifact represents.

Include a compact findings table: correctness/anchor movement, transient and settled bottom gaps, frame/main-thread work, DOM/render changes, latency, repeated-run spread and limitations. Distinguish measured improvements from structural savings and visual judgment. Link raw summaries and representative traces.

Update this plan and the index with results, checks, review outcomes and artifact links. Mark Complete only when retained implementation and required evidence satisfy the exit conditions. If no replacement is worthwhile, archive the exploration with a clear recommendation and evidence. Report deployment status separately; do not deploy without an explicit request.

## Experiment log

The exploration used frozen production builds at `b22785c` and `b11392e`. Confirmed failures were addressed as bounded chunks while the matched harness and recordings were assembled; each retained chunk received an independent review.

| Candidate | Hypothesis and scenario | Result and disposition | Evidence and next step |
| --- | --- | --- | --- |
| Observe the real scroll viewport and keep Virtuoso height notifications imperative | A pinned thread loses the bottom when composer growth reduces `clientHeight`; a `ResizeObserver` on the scroll parent can route that geometry change through the existing coalesced follow owner. Keeping list height out of React state removes a redundant render without changing policy. | Retain. Before the change, the focused Chromium test remained 113 px above bottom. After it, composer and viewport resize stay within the 3 px test tolerance; an intentionally unpinned reader remains anchored. This is a bounded Stage 2 fix plus the directly coupled Stage 4 state removal. | Focused timeline tests, responsive/build/trim checks and integrated Chromium resize/reading suites pass. Production profiling shows no regression in streaming mutation count or delta visibility; duplicate follow scheduling was investigated separately below. |
| Virtuoso prepend index plus stable-key residual correction | Replacing whole-container `scrollHeight` arithmetic with `firstItemIndex` should isolate prepended rows from concurrent growth. Preserve the latest visible row/offset when the reader moves while the request is pending. | Retain. The old implementation moved the original anchor outside the virtual window. `firstItemIndex` alone reduced a top-row case to a repeatable 3.390625 px, but a reader 458 px inside a long row still moved 130.453125 px. A stable-key/offset correction bounded to four post-commit frames removes that measured residual and cancels on new input. The final history boundary becomes a same-height “Beginning of conversation” marker, and surrounding header/footer content now belongs to Virtuoso measurement. Pure prepends retain the instance; thread changes, empty/refill and leading-row replacement rebase Virtuoso measurements. | The stress case combines live row growth and later user movement and passes `<2 px` in three repeated Chromium runs. The full five-case native-history suite and responsive two-tab revert suite pass, including leading-row removal. Build and trim pass; independent review found no major issue after the reset and keyboard-interruption fixes. The old synchronous mock of aggregate-height arithmetic was removed. The final history/disclosure recording demonstrates the retained behavior. |
| Explicit gesture direction instead of elapsed-time origin guesses | A deliberate upward move inside the 60 px bottom tolerance should pause immediately, while keyboard input targeting another pane must not change this pane's follow mode. Native gesture direction through `scrollend` should express that policy without 500 ms user-intent and 120 ms auto-scroll timers. | Retain. The old policy failed both focused Chromium regressions: a 24 px upward wheel hid the jump control and the next delta reclaimed the reader; ArrowUp on a focused control outside an inactive pane left that pane 356 px behind after its next delta. The candidate removes both timing windows, pauses on explicit upward wheel/touch/keyboard direction, permits deliberate movement toward bottom to resume, and limits body-level keys to the active primary timeline. Pointer scroll direction comes from actual `scrollTop` movement rather than scrollbar-width hit testing, including overlay scrollbars; a one-frame post-pointer window covers queued native scroll delivery and is canceled by new input or cleanup. | Four focused input regressions pass (small wheel, touch/selection pause, pointer-driven scrollbar ordering and cross-pane keyboard isolation), followed by 31 focused unit/component checks and the integrated Chromium scrolling/history/reading suites across desktop, narrow pointer and touch. Build and trim pass. Independent review drove stale-gesture, nested-timeline and pointer-ordering fixes and found no remaining major issue. The matched full-turn recordings include the 24 px reading pause and explicit return. |
| Pane-owned activity disclosure state | Activity group, show-more and nested item state should survive a row leaving and re-entering Virtuoso's render window without turning disclosure state into durable transcript data. | Retain. The baseline regression opened command 99 in a 100-command group, virtualized the row away and back, then found the entire group closed. The candidate stores only the interacted row's open flag, bounded visible count and open item IDs in the pane, resets synchronously on thread change and prunes removed rows/items. Existing direct renderers retain local state for isolated use. The behavior was extracted into focused modules instead of growing the already-large timeline and renderer files. | The browser regression passes in three repeated runs and preserves both the revealed second chunk and command 99's open output. The integrated activity-density, native-payload and streaming-reading cases pass with 46 focused component tests. Production build and trim pass. Independent review found and then verified fixes for controlled-open rendering and same-row-key thread isolation; no issue remains. |
| Flatten expanded activity children into the virtual list | A very large activity group might need child-level virtualization to avoid a long task when opened. | Reject. The existing 80-item render bound addresses the measured mount cost. In a production build, opening a 1,000-command group mounted 80 activity items and about 792 total document elements; five two-frame settle measurements ranged from 14.0 to 32.2 ms with no observed task over 50 ms. Child flattening would complicate row identity, grouping and accessible disclosure semantics without a demonstrated practical gain. | Keep the bounded group renderer. Treat these figures as the candidate diagnostic, not the final end-to-end performance comparison; the temporary instrumentation and config were removed. Revisit only if Stage 4 production traces show a different large-turn bottleneck. |
| Reduce Virtuoso overscan from 720 px to 360 px | The retained 720 px buffer may keep more complex rows mounted than fast scrolling needs. A half-viewport buffer should reduce offscreen work without showing an empty viewport. | Retain. Across five alternating production runs at 30, 300 and 1,000 rows, 360 px mounted seven initial rows instead of nine and about 398 total document elements instead of 428. Streaming mounted three or four rows instead of five. All 15 fast-scroll cases for each candidate had zero sampled blank frames; frame p95 stayed approximately 26.0–26.7 ms, delta visibility means stayed 57.7–59.6 ms versus 57.6–58.0 ms, and neither candidate recorded a streaming task over 50 ms. | The gain is structural and modest; no CPU/battery claim. Integrated desktop, narrow-pointer and touch regressions still pass. Keep 360 px unless the final video or broader validation exposes a physical-device blanking gap. |
| Remove sequence-driven bottom-follow scheduling | `totalListHeightChanged` already schedules the content-growth correction after Virtuoso measures it, while the viewport `ResizeObserver` owns composer/pane geometry. The additional `timelineLastSeq` layout effect may write the same bottom twice. | Retain. With the sequence effect, eight streamed deltas generated 16–18 scroll events in the production harness. Removing it reduced the normal result to eight without changing mutation counts, bottom gaps, blank frames, frame p95 or visible latency. It also removes the unused `timelineLastSeq` input and the hook's only layout effect. | The full timeline unit suite passes (278 tests, one skipped), as do 33 integrated scroll/history/streaming/activity/workspace browser cases with two expected skips. Production build and trim pass. Independent review verified coverage from Virtuoso measurement, the viewport observer and hidden-pane remount/restore and found no issue. |
| Add row indexes, caches or an always-on pruning fast path | Mapping and pruning all loaded rows could make text deltas scale with history length. | Reject. The frozen production harness showed nearly flat visible latency and bounded mounted DOM from 30 through 1,000 rows. Two temporary no-state disclosure-pruning prototypes did not produce a repeatable improvement under matched runs; the later runs were retained as contaminated evidence rather than used to claim a gain. Adding indexes or cache invalidation would increase state and synchronization cost without a demonstrated user-visible bottleneck. | Keep ordinary immutable row projection and the bounded pane-local disclosure map. Revisit only if a real profile shows history-size-dependent script work or long tasks. |
| Change streaming presentation cadence | A few extra milliseconds of buffering might reduce render work. | Reject for this exploration. Eight realistic deltas produced 19–20 DOM mutation batches, no clean-run task over 50 ms, and virtually identical baseline/final visible latency. Existing text animation quality was already approved, and the virtualizer work did not require changing its pacing. | Keep lifecycle and actionable controls immediate and retain the current text cadence. |

## Final recommendation and findings

Keep Virtuoso as the geometry owner with the thin pane-local policy now committed. Content growth follows Virtuoso's measured total height; pane and composer size changes use one `ResizeObserver` on the real scroll viewport; explicit input direction owns follow-versus-reading intent; prepends use `firstItemIndex` plus a bounded stable-key residual correction. Keep activity children grouped and capped at 80 rather than flattening them into the global virtual list.

Do not replace the virtualizer or add an index/cache layer. The confirmed defects came from duplicated policy, aggregate geometry and presentation state living inside remountable rows, not from Virtuoso's basic windowing. The remaining custom correction is bounded to prepend restoration and cancels on new input or thread replacement.

| Scenario | Baseline `b22785c` | Final `b11392e` |
| --- | --- | --- |
| Pinned viewport height shrink | Lost follow by 300 px; jump control stayed hidden | Settles within the 3 px browser tolerance |
| Pinned seven-line composer growth | Lost follow by 113 px; jump control stayed hidden | Settles within the 3 px browser tolerance |
| 24 px upward reading gesture plus live delta | Reader was reclaimed while still inside the 60 px near-bottom zone | Follow pauses immediately; explicit return resumes it |
| Concurrent live growth plus 20-row prepend | Original anchor left the virtual window; index-only prototypes left 3.39–130.45 px residuals | Stable surviving anchor stays within 2 px in three repeated stress runs |
| Activity group virtualized away and back | Group, revealed chunk and command disclosure reset | Group, second chunk and command 99 output remain open in three repeated runs |

The final five-run production profile used bundled headless Chromium, macOS on `jtkwmini`, 1280×900, no throttling and alternating build order. Two contaminated 1,000-row records (one baseline fast-scroll p95 of 46.4 ms and one final 55 ms streaming task with excess mutations) remain in the raw file and were replaced by three focused alternating runs; they are excluded from the representative ranges below.

| Metric | Baseline | Final | Finding |
| --- | --- | --- | --- |
| Initially mounted timeline rows | 9 at 30/300/1,000 loaded rows | 7 at 30/300/1,000 | Two fewer offscreen rows; history length does not grow mounted DOM |
| Total document elements | 428–434 | 400–402 | About 7% fewer in this fixture |
| Rows mounted after eight streaming deltas | 5 | 3–4 | 20–40% fewer, depending on row height |
| Fast-scroll sampled blank frames | 0 across 15 cases | 0 across 15 cases | No observed visual windowing regression |
| Fast-scroll frame p95, clean runs | 26.1–26.3 ms | 26.0–26.6 ms | No material change in this headless cadence |
| Delta-to-visible median across sizes | 55.4–56.7 ms | 56.1–57.6 ms | Within roughly 1 ms; added presentation latency was not needed |
| Eight-delta DOM mutation batches | 19–20 | 18–20 | No material change |
| Eight-delta layout work, median | 4.8–5.1 ms | 5.0–5.2 ms | No material change |
| Eight-delta total task work, median | 83–102 ms | 92–114 ms | Run spread overlaps; no CPU/battery improvement claim |
| Timeline production chunk | 113.98 kB / 35.78 kB gzip | 119.95 kB / 37.22 kB gzip | Correctness and disclosure state add about 5.97 kB minified / 1.44 kB gzip |

Complexity moved from elapsed-time inference and shared aggregate geometry toward explicit responsibilities: two elapsed-time inference windows were removed, including the only timeout; one viewport observer was added; the `totalListHeight` React state and sequence-driven follow effect were removed; content growth and viewport changes each have one trigger; prepend correction is bounded to four frames; disclosure state is pane-local, keyed and pruned. There remain two custom imperative writers by design: the bottom-follow owner and the isolated prepend residual correction, alongside Virtuoso's own geometry adjustments.

Validation completed with 278 timeline unit/component tests passed and one skipped, 33 integrated Chromium scroll/history/streaming/activity/workspace tests passed and two expected narrow split-pane cases skipped, repeated focused regressions, production build, frontend trim and independent reviews for every retained chunk. The full-turn, history/disclosure and compact split-pane recordings were decoded and visually inspected. Production React does not emit useful Profiler callbacks, so direct React commit counts were not injected into the shipped app; DOM mutation batches are the non-invasive commit proxy in this report. Physical overlay-scrollbar behavior and a real mobile software keyboard remain manual gaps; the gesture logic and compact/touch emulation passed, but browser emulation is not physical-device proof.

Artifacts stay out of Git under `tmp/scroll-exploration`: `profile-baseline.json`, `profile-focus.json`, `profile-overscan.json`, `profile-pruning.json`, the replay scripts, and four named WebM recordings in `videos/`. Deployment was not part of this exploration and has not occurred.
