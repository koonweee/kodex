# Timeline Scroll and Render Exploration

## Status and objective

Active as an implementation exploration on 2026-10-09. Execution has started; deployment remains separate and has not been requested.

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

Status: Active.

Freeze the starting commit and production bundle. Reuse canonical fixtures and existing browser helpers; create only a small deterministic replay harness where existing coverage is insufficient. Prove genuine running assistant text and valid canonical patch scopes rather than animating a static snapshot. Keep original production behavior available for matched comparisons.

Capture the two confirmed resize failures first. Then reproduce and rank upward-input races, interrupted return-to-bottom, delayed prepend, disclosure remount, completion consolidation, external approval/debug content changes and hidden-pane recovery. Separate confirmed failures, design decisions and unreproduced risks.

Use variable-height messages, Markdown, delayed media sizing and tool activity. Include short non-overflowing transcripts, ordinary history and a stress history (initial targets: approximately 30, 300 and 1,000 loaded rows), plus one very large expanded turn. Select a few representative cases for repeated performance runs; do not multiply every scenario by every device.

Record frame-by-frame anchor coordinates and bottom distance around each event. For reading, identify a surviving visible item and its intra-item position; distinguish intentional user movement and disappearance of the anchor from unwanted drift. Record restoration time, maximum transient displacement and settled error. CLS or eventual settled position alone is insufficient.

Exit: reproducible baseline clips, a prioritized failure inventory, baseline noise/tolerances and a bounded comparison harness. No performance claims from source inspection alone.

## Stage 2: Establish one scroll owner

Status: Pending.

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

Status: Pending.

Replace aggregate scrollHeight-delta restoration with the selected owner's supported prepend anchoring. If additional anchoring is necessary, use a stable visible key and offset locally; do not add a second restoration engine. Verify variable estimates, delayed measurement, concurrent output, history exhaustion/failure and user navigation during the request. Pending loads must respect the reader's latest position, not force an old capture back into place.

Define a deterministic fallback when completion, canonical replacement or revert removes the anchor: preserve a surviving neighbor where appropriate, or the final bottom when following. Do not retain obsolete canonical rows just to preserve pixels.

Preserve activity expansion and show-more state across virtualized remounts using the smallest pane-local keyed state already justified by Worked expansion. Bound its lifetime to retained rows/thread identity and clean it up on removal. Check nested disclosure focus and selection behavior; do not build a general presentation cache.

Test whether flattening expanded Worked children into the presentation list improves a measured large-turn problem. Preserve canonical row identity and accessible group/disclosure semantics; this is a presentation projection, not a new authoritative transcript. Compare with existing bounded rendering and reject flattening if the practical benefit does not justify its complexity.

Exit: prepend and automatic restructuring preserve reading within measured tolerance, surviving disclosures retain their state, and large expanded turns have a documented keep/change decision.

## Stage 4: Reduce render and measurement cost

Status: Pending.

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

Status: Pending.

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

Status: Pending.

Deliver a concise final recommendation: the chosen geometry owner and follow policy, what was rebuilt/deleted, what remained, rejected alternatives and why, plus any remaining risks. Include a complexity comparison (scroll writers, observers, timers and state responsibilities); line count alone is not a quality metric.

Provide matched baseline/final full-turn recordings and short demonstrations of viewport/composer resizing, scrolling away and returning during streaming, history prepend, disclosure remount and completion. Include a representative narrow-pane and multi-pane demonstration. Show a meaningful rejected alternative only when it explains the decision. Link playable video files directly in the conversation, not only inside a report/comparison page. Keep bulky videos/traces out of Git and identify which build each artifact represents.

Include a compact findings table: correctness/anchor movement, transient and settled bottom gaps, frame/main-thread work, DOM/render changes, latency, repeated-run spread and limitations. Distinguish measured improvements from structural savings and visual judgment. Link raw summaries and representative traces.

Update this plan and the index with results, checks, review outcomes and artifact links. Mark Complete only when retained implementation and required evidence satisfy the exit conditions. If no replacement is worthwhile, archive the exploration with a clear recommendation and evidence. Report deployment status separately; do not deploy without an explicit request.

## Experiment log

Stage 1 remains active while the broader failure inventory and production-build baseline are assembled. The first confirmed failure had a sufficiently small, independently testable correction, so it was evaluated early rather than leaving a known defect in later baseline work.

| Candidate | Hypothesis and scenario | Result and disposition | Evidence and next step |
| --- | --- | --- | --- |
| Observe the real scroll viewport and keep Virtuoso height notifications imperative | A pinned thread loses the bottom when composer growth reduces `clientHeight`; a `ResizeObserver` on the scroll parent can route that geometry change through the existing coalesced follow owner. Keeping list height out of React state removes a redundant render without changing policy. | Retain provisionally. Before the change, the focused Chromium test remained 113 px above bottom. After it, composer and viewport resize stay within the 3 px test tolerance; an intentionally unpinned reader remains anchored. This is a bounded Stage 2 fix plus the directly coupled Stage 4 state removal, not the final ownership decision. | Focused timeline tests, responsive/build/trim checks and isolated Chromium resize/reading suites pass. Continue Stage 1 baseline capture, then test input races and prepend anchoring. Compare production-build render/measurement counts before making a performance claim. |
| Virtuoso prepend index plus stable-key residual correction | Replacing whole-container `scrollHeight` arithmetic with `firstItemIndex` should isolate prepended rows from concurrent growth. Preserve the latest visible row/offset when the reader moves while the request is pending. | Retain provisionally. The old implementation moved the original anchor outside the virtual window. `firstItemIndex` alone reduced a top-row case to a repeatable 3.390625 px, but a reader 458 px inside a long row still moved 130.453125 px. A stable-key/offset correction bounded to four post-commit frames removes that measured residual and cancels on new input. The final history boundary becomes a same-height “Beginning of conversation” marker, and surrounding header/footer content now belongs to Virtuoso measurement. Pure prepends retain the instance; thread changes, empty/refill and leading-row replacement rebase Virtuoso measurements. | The stress case combines live row growth and later user movement and passes `<2 px` in three repeated Chromium runs. The full five-case native-history suite and responsive two-tab revert suite pass, including leading-row removal. Build and trim pass; independent review found no major issue after the reset and keyboard-interruption fixes. The old synchronous mock of aggregate-height arithmetic was removed. Capture matched video and trace evidence before final retention. |
