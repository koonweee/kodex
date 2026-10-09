# Chat Turn Layout and Motion Polish

## Status and objective

Complete as an implementation exploration on 2026-10-09. Deployment is separate and has not been requested.

Make a normal chat turn feel composed from Send through progress, intermediate output, disclosures and completion. Reduce unnecessary rendering and avoidable layout shifts first. Use subtle motion where movement remains useful or unavoidable, without delaying content, controls or authoritative state.

Build on the deployed [streaming assistant text animation](streaming-assistant-animation.md). Preserve its current four-group fade and 48 ms batching as the starting point. The user accepts a few milliseconds of extra presentation latency when a measured performance benefit justifies it; this does not authorize buffering lifecycle events or delaying approvals, errors, Stop or input acknowledgments.

The output is a tested, reviewable implementation plus a recommendation supported by full-turn videos and performance findings. Every candidate below must receive a disposition; not every candidate needs to ship. A simple immediate transition is a valid result when animation adds cost or weakens usability.

## Boundaries and simplicity rules

- Work within timeline, composer, queued-input, approval and existing shared presentation owners. Keep App.tsx a coordinator. Preserve canonical snapshots, patches and deltas, native submission/queue routing, and existing two-client convergence.
- Use browser-local state only for disposable presentation, focus, disclosure and scroll. Never use animation state to decide lifecycle, message identity, command routing or whether canonical content is applied. Completion and replacement win immediately.
- Prefer removing a layout change, preserving dimensions, or adding an empty-state fast path over compensating machinery. Reuse existing CSS and native Web Animations before considering a dependency.
- No new animation framework, global scheduler, duplicate transcript, persistent presentation ledger, ID-alias system, backend buffering, generic layout cache or custom virtualizer. No broad renderer/parser rewrite. Do not copy hidden content into a second measured tree or screenshot it merely to animate a transition.
- A shared helper is justified only after two retained cases demonstrate the same contract. Do not generalize the first prototype. Remove superseded code and rejected switches rather than retaining parallel paths.
- Coordinate visual changes in existing component boundaries. Do not build a cross-feature transaction system just to make independent gateway events appear simultaneous. If a clean handoff cannot be achieved locally, prefer a stable shell or an immediate update.
- Keep content and actionable controls available immediately. Never hold a completed turn open or retain a stale interactive approval/error card for an exit animation.
- Read theme guidelines and the typed theme token contract before styling. Reuse semantic colors, preserve settled contrast, respect reduced motion, and follow the existing pane/viewport/input ownership contract.
- No deployment, new preferences, broad navigation redesign, unrelated spacing overhaul or changes to native protocols. A materially broader solution requires a separate scope decision.

## Starting evidence

Recheck these code observations against the checkout at execution time. They identify candidates, not measured bottlenecks.

| Area | Existing behavior and relevant owner |
| --- | --- |
| User-message handoff | `timeline/reducer.ts` creates optimistic rows, then removes matches when canonical rows arrive; their render keys can differ. `messageRenderers.tsx` conditionally adds upload/failure status. Canonical IDs must remain authoritative. |
| Work header | `timeline/workRenderer.tsx` renders a plain running header and completed disclosure markup. The running timer is already local and updates at 1 Hz; it is not a reason to introduce a global clock. |
| Activity groups | `timeline/activityRenderers.tsx` constructs up to 80 child summaries even when the outer group is closed. Individual detail bodies are already lazy. |
| Timeline derivation | `timeline/TimelineView.tsx` rebuilds row/approval mappings as rows change. Empty-approval fast paths may remove unnecessary nested scans. Rows/renderers are already memoized and unchanged row identities are preserved on text deltas. |
| Scrolling | `useBottomPinnedVirtuosoTimeline.ts` owns bottom-follow and reading pauses. Height notifications and layout effects interact with Virtuoso measurements; do not introduce a competing scroll owner. |
| Existing geometry protection | Final assistant footers already reserve space; user attachment thumbnails have defined dimensions. Keep these protections. |
| Existing motion | `composer/useInlineComposerMotion.ts` already handles a small composer transition; command counts and disclosure carets have localized motion. Avoid stacking a second animation over them. |
| First Markdown display | `timeline/rendererShared.tsx` loads Markdown lazily with a plain-text fallback. A cold first render may change geometry when formatting loads. |

Use the existing native settings/canonical SSE fixtures, streaming tests, disclosure/queue tests and performance scripts where useful. Temporary artifacts from the earlier exploration may be missing; do not make them a required dependency or mistake historical results for this baseline.

## Iteration procedure

For each candidate, record the problem, hypothesis, smallest experiment and success criterion before editing. Start behavior changes with a failing focused test when practical; visual tuning needs browser evidence rather than CSS/config-string assertions.

Compare against both the frozen starting baseline and the currently retained implementation. Change one meaningful variable at a time, inspect normal-speed video, then check correctness and work/latency. Keep, revise or discard the experiment and update this plan in the same change. Reorder remaining candidates when evidence changes priorities. Do not relax correctness or performance criteria silently to retain a favorite animation.

Timebox a prototype to roughly half a day and one or two focused tuning passes before a decision. If it needs layers of identity tracking, observer coordination or special-case scroll logic, simplify or reject it. Larger costs revealed by profiling can be documented for a separate plan.

Each retained chunk gets independent review, relevant passing checks, updated evidence and a focused commit. Routine tuning and candidate selection are in scope when execution is authorized; they do not require repeated approval gates.

## Stage 1 Establish a full-turn baseline

Status: Complete. The final bounded harness uses production bundles and valid canonical turn/row-delta patches, including a canonical pending user precursor before Working and true running item-upsert semantics while assistant text streams. Earlier fixture iterations that violated patch scope, item order or live-item status are explicitly excluded from the report.

Build a small reproducible turn sequence through the real canonical frontend path: compose, Send, optimistic display, acknowledgment, Working, intermediate commentary, tool/file activity, final response and completion consolidation. Include one disclosure interaction while output continues. Use a production build and fixed payloads/timing; do not create a benchmark platform.

Record representative variants:

- Warm and cold first turn, short and multiline drafts, and attachments/quotes/skill mentions disappearing from the composer after submission.
- Fast acknowledgment and delayed acknowledgment; ordinary submission, authoritative queue outcome, upload/submission failure and Stop. No invented local routing.
- Steady output and activity bursts, a long Markdown reply, many tool summaries, and completion after substantial intermediate work.
- A reader at the bottom, a reader scrolled upward, and a reader opening a detail panel while the turn changes elsewhere.
- A short disclosure and a tall command output/diff; repeat toggles, resize during transition, queue expansion and a arriving/resolving approval or question.

Select a few critical fixtures for repeated performance runs rather than multiplying every case by every device configuration. Record viewport/pane dimensions, pointer capabilities, payload size, build/commit, browser, host and throttling. Capture matched full-turn recordings.

Measure separately: event receipt to visible content/control, React commits in a targeted profiling pass, browser task/script/layout work, frame interval distribution and >50 ms tasks, DOM/mount counts, and measurement/scroll-adjustment frequency. Track the viewport position of an existing visible reading anchor and distance from the bottom around transitions. Keep expected content growth distinct from avoidable displacement. CLS alone is insufficient inside a scroll container and can exclude shifts following input.

Exit: reproducible baseline recordings, an inventory of visible jumps and expensive work, and prioritized experiment targets. No performance conclusion from source inspection alone.

## Stage 2 Remove unnecessary work and stabilize geometry

Status: Complete. Every candidate has a recorded disposition below.

Evaluate all candidates below. Start with the strongest measured bottleneck and the send/completion handoffs; small independent fixes can precede visual prototypes.

| Candidate | Smallest experiment | Acceptance and stopping rule |
| --- | --- | --- |
| Closed activity groups | Mount child summaries only while the outer group needs them; retain bounded chunking. | Closed groups do less work, opening shows current content, and append does not reset an expanded/read-more view unexpectedly. Preserve existing user-visible disclosure state without an unbounded cache. |
| Empty approval scans | Add cheap empty-state paths at existing derivation boundaries. | Remove demonstrated unnecessary traversal without changing anchored/unanchored approval results or missing a newly arrived request. Profile before introducing another index. |
| User-message handoff | Match optimistic/canonical geometry and suppress duplicate entrances. Keep transient status within a compact stable footprint where useful. | Exactly one visible message after acknowledgment; no extra jump, lost attachment, replayed entrance or lost focus. Do not invent canonical aliases, key all history by client IDs, or retain duplicate rows. If stable DOM identity requires this, accept replacement and preserve geometry instead. |
| Composer send transition | Coordinate cleared draft/accessories and message appearance through existing ownership and motion. | No avoidable successive height jumps; textarea identity, focus, IME, selection, failed-send recovery and edits made during submission survive. Do not delay acknowledgment or create a new submission state machine. |
| Working to Worked | Keep header height, divider and caret allocation consistent; use stable numeric geometry for elapsed time. | Label/timer changes do not shift surrounding content, with correct accessible disclosure semantics when details become available. Do not leave invisible focus targets or reserve a large blank panel. |
| Intermediate summaries | Stabilize icon/count/status footprints and wrapping; coalesce decorative changes using existing batching only. | Burst updates stay readable and do not repeatedly move controls. Do not hide meaningful warnings or truncate the only route to required information. |
| Completion consolidation | Apply canonical completion promptly, preserve final-footer geometry and the visible reading anchor as intermediate rows consolidate. | No multi-step collapse/reappear effect or unexpected jump. Preserve user-expanded content and intended history semantics. Do not hold obsolete rows to fake continuity. |
| Cold Markdown load | Compare early module preload when a chat becomes active with current lazy loading. | A measured first-turn geometry/latency improvement justifies the transfer/parse cost. Check cold startup too; avoid eager loading every rich renderer. |
| Scroll/measurement churn | Profile existing height notifications, repeated reads and follow requests; remove only demonstrated duplication within the existing owner. | Preserve initial alignment, prepend restoration, manual reading pauses and virtualizer correctness. No second anchoring engine or continuously running geometry observer. |

Exit: disposition and evidence for every candidate; retained changes reduce unnecessary work or visible displacement without new lifecycle machinery.

## Stage 3 Selective motion and interaction polish

Status: Complete. Motion is retained only where the interaction has reliable local provenance and does not animate layout.

Compare the stabilized no-new-motion version first. Trial timings are 120–160 ms for entrances/label changes and 140–180 ms for small deliberate disclosures, using restrained easing. These are starting points, not hard-coded acceptance requirements. Effects should finish rather than queue when updates arrive rapidly.

| Surface | Experiment | Guardrail |
| --- | --- | --- |
| New user bubble | Brief opacity entrance; optionally compare 2–4 px translation. | Run once for a genuinely new send, not again for canonical replacement, history, reconnect or virtualization remount. If provenance is uncertain, snap. |
| Working/status labels | Compare immediate label updates with a small in-place fade. | No timer-digit animation every second, constant pulsing or change in header height. |
| Intermediate messages/tool rows | Brief entrance for genuinely new visible output. Compare grouped burst treatment with immediate insertion. | No stagger queue over dozens of rows; settled content must not refade. Avoid multiplying row fades with the existing text fade. |
| Completion | Try subtle opacity on newly available footer/header controls after final geometry is applied. Only prototype small displacement smoothing if baseline evidence still warrants it. | Transform/opacity alone does not remove sibling layout shifts. Do not scale whole messages, animate the entire list, or tween every automatic height change. For large consolidation, prefer correct anchoring and immediate layout. |
| Work/tool/file/quote disclosures | Compare immediate body insertion plus fade with bounded height animation for small explicit opens/closes. | Keep the clicked header stable; retain native keyboard/ARIA behavior. Tall/streaming bodies use immediate geometry if animation adds measurement churn. Repeated toggles, resize and interruption must cancel or retarget cleanly. |
| Queue/composer accessories | Reuse existing composer motion where the queue or accessory stack affects available height. | Preserve drafts and button positions; no nested competing height animations, keyboard-viewport animation or animated scrolling during typing. |
| Approvals/questions/errors | Stabilize the surrounding shell and optionally fade new content. | Actions remain immediately available. Resolution cannot leave stale clickable controls; keyboard focus has a valid destination when content disappears. |

A tiny local transition helper is acceptable if repeated retained use justifies it. Avoid `transition: all`, persistent `will-change` across history, large compositor layers and per-frame React state updates. Height animation is a measured exception: it can trigger layout and Virtuoso remeasurement on every frame. Do not replace all native disclosures just to get uniform motion.

Exit: each surface has a documented motion/no-motion policy; retained effects improve full-turn recordings, remain bounded, and do not amplify layout or scroll work.

## Stage 4 Integrated correctness and performance

Status: Complete. Focused component and bundled-Chromium suites pass, independent review findings are resolved, and matched production-build comparisons meet the decision rules.

Replay the whole turn after combining retained changes; individually pleasant effects can conflict when Send, queue/composer resizing, tool output and completion overlap.

Correctness coverage must include:

- Canonical acknowledgment, queue outcome, interrupt, error, snapshot replacement, revert, thread switch and unmount during motion. No duplicated/resurrected content or animation-gated lifecycle.
- Reduced motion, hidden/foreground recovery, history hydration and virtualizer remount. Discard stale visual work; no replay of old entrances.
- Selection/copy, keyboard disclosure navigation, focus after collapsing/removing content, touch targets, screen-reader names/states and no repeated announcements caused by decorative wrappers.
- Continued typing, IME and draft preservation across send/queue updates, width/height resize, fullscreen composer changes and keyboard viewport changes.
- Bottom-follow and paused reading during growth/consolidation, explicit short/tall disclosure, older-history prepend and final-footer visibility.
- Desktop fine pointer, narrow fine pointer, narrow touch, wide touch with compact pane, hybrid input, adjacent compact/regular panes, and more than one streaming pane.
- Same-user two-tab shape: one client submits or acts, another misses events or is hidden, and both converge through canonical state. Presentation may differ locally; authoritative content/actions must not.

Use `$agent-browser` with bundled Playwright Chromium alongside focused Playwright assertions. If unavailable, document that and use the permitted bundled-Chromium route with recordings and rendered evidence. Do not launch installed Google Chrome. Check representative light/dark themes; use the full shared-theme contrast gate only if shared colors/control mappings change.

Performance decision rules:

- Run performance-critical comparisons at least three times with matching payloads/build mode and settings; report medians and ranges. Alternate reference/candidate order where drift is plausible. Separate video/profile runs from lighter quantitative runs.
- Check host contention before interpreting results. Pause benchmarks during competing compilation/tests/browser jobs without stopping unrelated work. Preserve contaminated runs as excluded evidence and repeat on a quiet host; do not mark a performance gate passed from noisy data.
- Investigate repeatable >10% increases in frame p95 or relevant main-thread work, new recurring >50 ms tasks, added input latency, or extra scroll/measurement churn. Simplify or reject material regressions. A higher percentage alone is an investigation trigger, not automatic proof of user-visible harm.
- Establish anchor-displacement tolerances from baseline noise before comparing. Aim for no extra displacement of a surviving reading anchor during automatic updates; assess deliberately expanded content separately. No degradation in bottom-follow or click-target stability.
- No intentional delay for canonical application or actionable controls. Measure receipt-to-visible and receipt-to-settled separately so motion does not conceal delay. Any modest added presentation latency needs a demonstrated benefit.
- Hidden/settled/completed content does no continuing animation work. DOM, callbacks and observers remain bounded and clean up on interruption/unmount; old history does not acquire permanent animation bookkeeping.
- If repeatable timing cannot be obtained, report the limitation and leave the affected performance exit condition pending. A node-count reduction may be reported as such, but does not prove CPU, battery or frame-time improvement.

Run closest domain tests, relevant existing streaming/reading/footer, disclosure, queue and composer browser tests, `cd apps/web && npm run build`, and `./tools/trim-frontend.sh`. Do not broaden testing without a changed contract or unresolved concern. Preserve meaningful regression coverage; do not add tests asserting animation constants or CSS strings.

Exit: integrated correctness passes, relevant performance gates have usable evidence, independent review findings are resolved, experimental code is removed and the retained implementation stays small. No hidden validation waivers.

## Final recommendation and artifacts

Deliver a clear recommendation for the best overall behavior: what was stabilized, what work was removed, where motion helps, where snapping is preferable, and what was rejected because the cost/complexity exceeded its value.

Provide matched baseline/final full-turn videos, short clips of meaningful alternatives, and a stress/interaction demonstration covering completion consolidation, reading position and disclosure during streaming. Include representative narrow-pane behavior and multi-pane performance evidence. Link video files directly in the thread as well as from a local comparison page; screenshots alone do not demonstrate motion. Do not commit bulky videos/traces or user uploads.

Include a compact results table covering anchor displacement, frame distribution/long tasks, browser work, targeted render/mount evidence, receipt-to-visible/settled latency, and cleanup. State environment, repetition/spread, excluded runs and measurement limitations. Separate structural savings from measured CPU claims and visual judgment. Link raw summaries and representative profiles.

Record retained and rejected candidates, exact final behavior, test/build/trim/review outcomes, limitations and deployment status here. Keep the index synchronized. Mark Complete only when all stages have a disposition, retained work meets exit conditions and artifacts are delivered. If the exploration yields no worthwhile implementation, archive it with the evidence. Deployment requires a separate explicit request.

## Execution result

Retain a small combination of structural work removal and local motion:

- Closed activity groups now render their summary only. Child summaries mount on first expansion, remain mounted afterward so nested open state survives close/reopen, and keep the user's `Show more` limit when new activity appends.
- Empty approval projections return before recursively walking timeline rows. The avoided traversal is certain, but matched runs did not show a measurable speed improvement, so this is recorded only as a structural simplification.
- Explicit activity-group and non-command activity-item contents use a 140 ms opacity/2 px entrance. The native disclosure owns geometry immediately; there is no height tween or per-frame React state.
- The final assistant toolbar already reserves its space while streaming. Completion now transitions that same DOM node from transparent to visible over 140 ms. It is actionable as soon as canonical completion applies.
- Reduced motion disables the retained effects. Settled content performs no continuing animation work.

The final behavior intentionally leaves user-message handoff, Working/Worked labels, completed-work and command bodies, intermediate row insertion, queue/composer accessories, approvals, questions and errors immediate. A new-user entrance prototype was removed during review because optimistic provenance does not prove a fresh mount; virtualization or a delayed canonical handoff could replay it. The completed-work body trial was also removed because expanded work state survives virtualization and would replay the fade when remounted. Working-header geometry did not produce a demonstrated vertical shift, and reserving additional label/caret width would add visible blank space without measured value. Intermediate-row entrance provenance is similarly uncertain. Approvals, questions and errors stay immediately actionable. Existing composer motion remains the sole owner of composer expansion.

Canonical completion continues to consolidate intermediate rows immediately into a closed Worked disclosure. An open command therefore closes at completion, while the surviving reading anchor, user message and composer remain fixed. Preserving nested open state across that reparenting would require cross-parent identity state or leaving very large work sections expanded; both were rejected. The final toolbar fade and the existing scroll owner provide the useful polish without hiding stale interactive content.

Cold Markdown preloading was rejected: the corrected cold recording showed no automatic reading-anchor displacement, and eager transfer/parse work had no demonstrated benefit. No additional scroll scheduler, height observer or Working timer was added because callback/height-change counts stayed stable and existing browser tests already protect follow, reading pause and prepend behavior.

### Performance findings

The accepted harness ran the production frontend in Playwright's bundled Chromium on Apple Silicon at a 1280×900 viewport. It covers one 980×840 desktop fine-pointer pane, one forced 360 px compact pane, and two simultaneous 489.5 px thread panes. Stress runs used 80 command summaries and 4× CPU throttle. Each quantitative condition has three runs; video, DOM-audit and animation-audit runs are separate. The harness uses a deterministic canonical API/SSE fixture rather than a live native runtime. Text-cue timing measures DOM matching, not paint or visibility, and is therefore excluded from latency claims.

The single-pane timing comparisons use the earlier reviewed production bundle; the subsequently removed Worked-body selector was inactive because those workloads never opened Worked. Current final videos and motion audits, plus all two-pane measurements, use the final reviewed bundle without that selector.

| Comparison | Baseline median (range) | Candidate/final median (range) | Result |
| --- | ---: | ---: | --- |
| Closed stress pane nodes | 1,047 | 326 | 68.9% fewer nodes before first disclosure open |
| Activity-only task work | 1,232 ms (967–1,427) | 955 ms (922–972) | 22.5% lower median; baseline spread is broad |
| Activity-only script work | 747 ms (627–904) | 590 ms (584–612) | 21.0% lower median |
| Activity-only frame p95 | 26.2 ms (26.1–26.2) | 26.2 ms (26.2–26.2) | unchanged |
| Integrated warm task work | 760 ms (755–804) | 781 ms (775–788) | +2.8%, within the investigation threshold |
| Isolated retained-motion layout work | 57.6 ms (52.4–63.9) | 56.6 ms (43.8–64.5) | no repeated layout regression |
| Isolated retained-motion frame p95 | 26.1 ms (20.1–26.1) | 26.1 ms (26.0–26.1) | unchanged |
| Two-pane workspace nodes | 1,985 | 543 | 72.6% fewer nodes across both panes |
| Two-pane task work | 1,751 ms (1,646–2,043) | 1,907 ms (1,658–3,369) | +8.9% median; one severe final-tail outlier |
| Two-pane frame p95 | 26.3 ms (26.2–26.9) | 26.2 ms (26.1–51.2) | median unchanged; no clean-tail claim |
| Automatic reading-anchor displacement | 0 px | 0 px | unchanged in repeated warm and closed-stress runs |

One unpaired integrated stress wave reported 40.2% higher layout work and one warm wave reported 14.1% higher style work. The required alternating isolation did not reproduce either increase: retained motion measured −1.7% layout and −6.1% style with overlapping ranges. These outliers remain in the evidence rather than being discarded. The two-pane final set also retains one severe run with 3,369 ms task work, 51.2 ms frame p95 and 17 long tasks. The other two final runs are near their matched baselines, so this is not a repeatable regression, but the evidence does not support a multi-pane speedup or clean-tail claim. The 72.6% workspace node reduction is the reliable two-pane result.

The multiline composer contracts by 21 px after Send in both baseline and final recordings; this is expected draft clearing, while the existing reading anchor remains stable. The forced compact-pane final recording preserves its prior anchor and user message while the compact composer performs its expected reset. Automated clicks on an initially offscreen tall disclosure scroll it into view equally in baseline and final; canonical completion itself adds 0 px displacement.

The closed-group DOM audit records 12-command descendants dropping from 120 to 11 and child summaries from 12 to zero before first open. Both builds have 119 descendants and 12 summaries after opening and after closing again, which confirms that the retained implementation saves initial work without discarding disclosure state. The 140 ms activity/footer effects finish, and the reduced-motion audit observes neither. The same final-footer node remains hidden and inert while streaming, becomes visible and actionable within the first sampled 102 ms after completion receipt, and reaches full opacity by 235 ms.

### Correctness and review

- Focused Vitest: 54 tests passed across activity, file, message and TimelineView rendering.
- Bundled-Chromium Playwright: 62 tests passed across canonical send handoff, streaming animation/footer, reading intent, intermediate density, inline composer motion, queue disclosure and native queue/Stop/failure/approval/question convergence. The matrix includes desktop, narrow fine pointer, narrow touch, wide touch with a compact pane, hybrid input and same-user two-tab cases where applicable.
- Production build and `./tools/trim-frontend.sh` pass.
- Independent review found and resolved one stale deferred-mount test and removed the optimistic user entrance that could replay on remount. No material findings remain in the retained implementation.
- No API, gateway lifecycle, generated contract or shared-state ownership changed. Deployment remains separate.

### Artifacts

- [Local comparison page](../tmp/chat-turn-polish/comparison.html)
- [Accepted raw evidence](../tmp/chat-turn-polish/full-turn-evidence.json)
- [Reproduction commands and measurement limits](../tmp/chat-turn-polish/README.txt)
- [Baseline cold multiline turn](../tmp/chat-turn-polish/true-stream-baseline-cold-video/full-turn-cpu1-run1/recording.webm)
- [Final cold multiline turn](../tmp/chat-turn-polish/true-stream-final-cold-video/full-turn-cpu1-run1/recording.webm)
- [Baseline paused-reading stress](../tmp/chat-turn-polish/true-stream-baseline-reading-video/full-turn-cpu4-run1/recording.webm)
- [Final paused-reading stress](../tmp/chat-turn-polish/true-stream-final-reading-video/full-turn-cpu4-run1/recording.webm)
- [Baseline open disclosure through completion](../tmp/chat-turn-polish/true-stream-baseline-open-completion-video/full-turn-cpu4-run1/recording.webm)
- [Final open disclosure through completion](../tmp/chat-turn-polish/true-stream-final-open-completion-video/full-turn-cpu4-run1/recording.webm)
- [Final compact-pane turn](../tmp/chat-turn-polish/true-stream-final-narrow-video/full-turn-cpu1-run1/recording.webm)

## Experiment and decision log

| Date / stage | Problem and hypothesis | Candidate | Visual and correctness evidence | Performance and limitations | Decision / next step |
| --- | --- | --- | --- | --- | --- |
| Planning | Code audit identifies geometry handoffs, hidden activity work and possible repeated scans | No implementation | Existing streaming/footer/composer protections identified | No new full-turn baseline yet | Proposed; begin with Stage 1 |
| 2026-10-09 / baseline | Initial harness variants used invalid full-snapshot scope, omitted the user precursor, and later mislabeled live assistant items as completed | Correct canonical turn/row-delta fixture | True streaming guard requires running item-upsert, hidden/inert footer and live spans | 68 development/invalid groups retained as excluded diagnostics; 39 corrected groups accepted | Use corrected v4 evidence only |
| 2026-10-09 / activity | Closed groups eagerly mounted up to 80 summaries and append reset `Show more` | First-open lazy mount with retained local contents/count | Open/current contents, append, nested detail and close/reopen tests pass | 68.9% fewer stress DOM nodes; task/script medians lower; frame p95 unchanged | Retain |
| 2026-10-09 / approvals | Empty approval arrays triggered two recursive row walks on every row change | Two empty-state returns | Existing approval arrival/resolution and two-tab browser flow passes | Traversal removed; matched timings overlap | Retain as structural-only |
| 2026-10-09 / geometry | Handoff, composer clearing, work transition and completion might move surviving content | Measure before adding state | Valid fixture records 0 px automatic anchor/user/composer displacement; one final user remains | 21 px textarea contraction is expected; tall-click scroll separated from completion | Keep canonical updates immediate; no geometry machinery |
| 2026-10-09 / motion | Whole-row entrances can replay, while local activity opens and the reserved footer have reliable provenance | User/Worked prototypes; activity/footer opacity trials | User and Worked prototypes removed in review; retained 140 ms effects finish and reduced motion snaps | Alternating isolation shows no task/frame/layout regression | Retain activity/footer motion only |
| 2026-10-09 / integrated | Queue, Stop, failure, approvals/questions, responsive input, two-tab and multi-pane flows must stay authoritative | Focused component/browser regression matrix plus compact/two-pane harness modes | 54 Vitest and 62 Playwright tests pass; build/trim pass; compact video and three two-pane pairs captured | Fixture remains synthetic; one severe two-pane tail is retained; no paint-latency or multi-pane speedup claim | Complete; deployment separate |
