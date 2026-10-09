# Streaming Assistant Text Animation

## Status and objective

Complete. Retain bounded word fades with 48 ms event batching. Implementation, comparison videos, repeated performance measurements and independent review are complete. Not deployed.

Make arriving assistant text feel fluid, using the user's 2026-10-08 ChatGPT screen recording as a visual reference. The observed effect is a pale leading edge that settles to solid text while older content remains stable. Match the useful visual qualities, not an assumed ChatGPT implementation or exact timing.

This is an exploratory frontend change. Compare small implementations, inspect them in motion, measure their cost, and keep the simplest version that delivers a clear improvement. The plan may revise its method, tuning and remaining steps as evidence arrives.

## Starting point and boundaries

Recheck these facts when execution starts:

- `apps/web/src/timeline/useTimelineEventQueue.ts` batches ordinary canonical events every 64 ms; full snapshots have an immediate flush path.
- `apps/web/src/timeline/messageRenderers.tsx` owns the memoized `AssistantMessageMarkdown` boundary and receives message identity, text and status.
- `apps/web/src/markdown/MarkdownContent.tsx` renders full text through React Markdown, GFM and line-break plugins. Changed active text reparses; memoization protects unchanged messages.
- Timeline rows use Virtuoso; one long message is still one Markdown row. Existing reading-intent and footer tests protect scrolling and completion geometry.

Preserve canonical snapshots, `thread_view.patch`, `thread_view.item_delta` and reducer reconciliation semantics. Treat the existing 64 ms cadence as a baseline to challenge, not a required final design. Compare batching/pacing changes when they can improve flow or latency; preserve event ordering, immediate canonical replacement and cancellation/recovery behavior. Animation is disposable per-pane presentation state, never a new source of text, lifecycle state, completion or shared command routing. Two tabs can animate differently but must converge on identical authoritative content.

Scope is live assistant message text. Do not expand into reasoning/tool animations, composer changes, backend/API changes, persistent settings or a general animation framework. No new dependencies by default. Do not introduce a custom Markdown parser, worker pipeline, permanent per-character DOM, transcript cache or global animation scheduler. Keep changes in focused timeline/Markdown modules rather than App.tsx. Frontend event batching, flush scheduling and visual reveal pacing are in scope. Do not add server-side buffering or change the wire contract merely for animation.

Read `docs/theme-guidelines.md` and `apps/web/src/theme/tokenContract.ts` before styling. Use existing semantic text colors; opacity supplies the effect. Readable settled content must preserve existing theme contrast. Respect reduced motion and do not deliberately leave the newest text unreadable for extended periods.

## Exploration loop

For each candidate:

1. State the visible problem and one hypothesis in the experiment log below.
2. Build the smallest reversible candidate. Start behavior-changing work with a failing focused test where practical; pure timing/visual tuning needs browser evidence, not CSS-string tests.
3. Replay the same input schedule as the baseline. Inspect recordings at normal speed and compare frame/performance evidence.
4. Tune one meaningful variable at a time: grouping, fade duration, starting opacity or, only if justified, pacing.
5. Keep, revise or discard the candidate. Record the reason, measurements, remaining defects and next experiment in this plan.
6. Independently review each retained implementation chunk, resolve findings and commit coherent passing changes. Remove rejected code before proceeding.

Timebox an individual prototype to roughly half a day before assessing it. Do not spend days polishing a method that needs architectural machinery. If a couple of tuning passes do not produce a worthwhile result, simplify or record why the experiment should stop. A negative result is valid; mark the plan Archived with evidence rather than Complete if no implementation is retained.

Plan edits are part of execution: update findings and remaining steps in the same change that changes direction. Keep the index status synchronized. Routine tuning and choosing among the candidates below are already in scope; do not add repeated approval gates. A materially broader renderer/backend transport rewrite requires a separate scope decision, not silent expansion or relaxed success criteria.

## Stage 1: Reproducible baseline

Status: Complete; production baseline recorded on 2026-10-09.

- Inspect existing Playwright fixtures and local performance helpers first. Reuse their canonical event/snapshot path; add only a small deterministic replay helper if needed, not a benchmark platform.
- Capture short prose resembling the reference, a long multi-screen answer, and mixed Markdown with headings, emphasis, links, lists, fenced code and a table.
- Use identical text and timing for baseline/candidates: steady small chunks, bursts separated by pauses, and a fast burst followed by completion. Record fixture sizes, delivery cadence, browser/build, viewport, hardware and CPU throttling.
- Use a production frontend build for performance comparisons. Warm it consistently and run each performance-critical baseline/candidate scenario three times; report medians and ranges rather than a single favorable run.
- Capture frame intervals/missed-frame proxy, main-thread long tasks, active-message render/parse cost using a targeted profile, and time from canonical text arrival to visible and settled text. Check animated-node/timer growth and cleanup. Avoid invasive instrumentation in every sample.
- Establish baseline scroll-follow behavior and responsiveness while typing in the composer during streaming. Historical artifacts may suggest scenarios, but are not a measurement of this checkout.

Exit: a small repeatable fixture set, a baseline recording/profile, and baseline-confirmed comparison budgets recorded here. Do not block exploration on perfect instrumentation.

## Stage 2: Compare small visual methods

Status: Complete; word fades at 48 ms retained.

Try A and B on the representative prose fixture, stopping early if a candidate clearly fails. Also test at least one simple pacing/cadence alternative against the current 64 ms baseline, both for visible latency and smoothness; the winning method may combine that change with a fade. Build on the same rendering boundary; temporary local switches are acceptable for comparison but must be removed before completion.

| Candidate | Hypothesis | Main risk / stopping rule |
| --- | --- | --- |
| A: fade newly appended text runs at existing batch cadence | A short fade hides abrupt chunk arrival with minimal bookkeeping | If chunk boundaries visibly pulse, try B; never restart a fade over the whole answer |
| B: lightly stagger small runs/words within each appended batch | A softer moving leading edge better matches the reference without extra Markdown parses per animation frame | Bound temporary wrappers and stagger duration; reject if stable text identity needs elaborate mapping or selection/layout breaks |
| C: batching/pacing alternative | A shorter, frame-aligned or simply adaptive flush cadence may improve flow and first-text latency; a small reveal buffer may smooth bursts | Change one scheduling variable at a time, preserve canonical ordering/replacement, and reject excessive parsing, display lag or timer complexity |

Start fade tuning around 150–300 ms; these are trial values, not claims about the recording or fixed implementation requirements. Prefer opacity with unchanged text geometry. Do not add blur, animated message height or word movement unless the simpler fade demonstrably fails and the extra cost is justified.

Keep full Markdown semantics. Test how new syntax reclassifies existing nodes before committing to an identity scheme. Prefer a simple source-position/append check or a graceful immediate-render fallback over complex tracking. Do not naively split Markdown on blank lines or permanently freeze blocks: references and later syntax can affect earlier content. It is acceptable for complex structures such as tables/code to update immediately if that is cleaner; record and visually verify the policy.

Exit: a documented A/B comparison and one retained method, or an evidence-backed decision to stop. A cadence comparison is required; a buffered or adaptive implementation is optional, not a promised milestone. Keep only the simplest cadence/pacing policy supported by evidence, even if that replaces the current 64 ms behavior. Stable-block parser optimization is outside this plan unless a small, separately justified change is sufficient; a general parser optimization project must not become an animation prerequisite.

## Stage 3: Polish and correctness

Status: Complete; focused tests, browser matrix and all 40 theme captures pass.

Keep the animated suffix and its metadata bounded by a short lifetime/size. Prune expired decoration on the next real text update and remove it on canonical replacement/completion, without breaking selection or restarting old animations. A stalled running message may retain its bounded, fully opaque suffix until that update; no quiet-period Markdown reparse or cleanup timer is needed. Avoid per-frame parent timeline state updates. Canonical replacements win immediately; no queued visual callback may resurrect obsolete text.

Add focused behavioral coverage, reusing existing tests where possible. If changing the shared event scheduler, cover canonical ordering, coalescing, immediate full-snapshot flush and cancellation in its existing tests, including read-only consumers:

- Append, burst, final completion and interrupt leave exactly the canonical content visible, with no duplicated/lost text. Completion must not wait for a visual queue; reveal the remaining suffix immediately.
- Snapshot replacement, shorter/corrected content, revert, message/thread switch and unmount discard obsolete animation work.
- Existing history, snapshot hydration, virtualization remount and foreground recovery appear immediately rather than replaying an old animation. If provenance is uncertain, prefer immediate display.
- Incomplete Markdown becoming valid does not flash settled content or corrupt links, lists, tables, code or copy output. Include Unicode/emoji and non-space-separated text if segmentation is used.
- Reduced motion shows content immediately. Selection, copying and keyboard/link interactions remain intact; do not add live-region announcements per animated segment.
- Auto-follow remains stable at the bottom; reading older content stays anchored. Completion preserves footer geometry and ordinary wrapping/resize behavior.
- Same-user two-tab shape: both observe a stream, one misses events or becomes hidden, then returns/refills. Both end with the authoritative text and status without stale animation playback. Do not change the canonical synchronization implementation for this presentation feature.

Use `$agent-browser` with Playwright's bundled Chromium for visual validation, alongside automated Playwright checks. If that skill is unavailable at execution time, report the limitation and establish a permitted browser-validation route; do not claim visual validation from static CSS/tests. Never launch installed Google Chrome through the gateway.

Inspect desktop fine pointer, narrow fine pointer, narrow touch, wide touch with a compact pane, and hybrid input. Include adjacent compact/regular panes, one versus multiple streaming panes, selection while streaming, resize, and reduced motion. Reuse the responsive matrix rather than inventing device classifications. Review supported themes for the fade's readability without changing shared theme mappings.

## Stage 4: Performance decision and cleanup

Status: Complete; measured overhead investigated and accepted with the limitations below.

Run the retained candidate against the same baseline fixtures, including a long answer, mixed Markdown, multiple streaming panes and CPU throttling. Use recordings for visual judgment and profiles for cost; a pleasant short prose example alone does not establish success.

Initial decision budgets, to confirm against baseline variance in Stage 1:

- Aim for fluid animation within the display's frame budget on the ordinary desktop fixture (16.7 ms at 60 Hz). On throttled/long-answer fixtures, compare with baseline rather than claiming universal 60 fps.
- Investigate a repeatable >10% increase in p95 frame interval or active-message main-thread work, any added recurring >50 ms tasks, or input/scroll degradation. If noise exceeds that threshold, collect a targeted trace/repeat; do not silently waive the comparison. Simplify or reject if the regression remains material.
- Do not add intentional delay before the first visible text in A/B. Target <=300 ms added arrival-to-settled time; any optional reveal buffer must catch up within that same budget under bursts, or snap immediately. Measure end-to-end event-receipt-to-visible latency as well as presentation delay so changing the flush cadence cannot hide latency in the accounting. Completion/interrupt/foreground recovery must not wait for it.
- No animation-driven full-message Markdown parse every frame. Animated DOM and scheduled work must stay bounded as the answer grows and return to baseline on completion/unmount; zero continuing animation work after settling or while hidden. A stalled running message may keep at most the bounded suffix as inert, fully opaque spans.

Run relevant focused component tests and `tests/streaming-reading-intent.spec.ts` / `tests/streaming-message-footer.spec.ts`, then `cd apps/web && npm run build` and `./tools/trim-frontend.sh`. Add targeted browser assertions for actual regressions, not class names, CSS strings or arbitrary timing constants. Broaden testing only where changed behavior warrants it. If shared theme/control mappings unexpectedly change, the repository's theme contrast checks apply.

Remove experimental switches, unused helpers, losing candidates and profiling hooks. Keep only useful fixtures/regression tests. Request independent review of the final diff, Markdown edge cases, presentation-state ownership, cleanup and performance evidence; resolve material findings. Deployment is separate and is not authorized by this plan.

Exit: visible improvement in recordings, acceptable measured cost, passing relevant checks/review, bounded implementation, no unresolved correctness regressions, and the recommendation package below delivered. Record the selected method, final tuning, measured tradeoffs and deliberate immediate-render fallbacks here; update the index to Complete. Record skipped/blocked validation explicitly rather than marking it passed.

## Final deliverable: recommendation, videos and performance findings

Finish with a concrete recommendation for the best path, not merely a selected implementation or a list of experiments. Explain the chosen animation and batching/pacing policy, why it beats the baseline and alternatives, what should be retained, and any remaining work before shipping. Distinguish measured findings from visual judgment and estimates. Keeping the baseline is acceptable only if the evidence shows the alternatives are not worth their cost.

Deliver accessible, clearly labeled video artifacts alongside the written findings:

- Baseline versus recommended candidate using identical text, chunk timing, viewport and playback speed; use side-by-side or matched clips so the effect is directly comparable.
- A short comparison of the meaningful alternatives, including the cadence/pacing experiment, showing why the recommendation won. Do not require exhaustive footage of every tuning value.
- A stress demonstration covering a long/mixed-Markdown answer and bursty delivery, plus representative narrow-pane/scroll behavior. A few concise clips may cover these together.

Keep videos in an accessible local artifact location and link them from the final response and this plan. Record fixture/configuration and timestamps where useful. Do not commit bulky recordings, traces or the user's reference upload. If video capture is blocked, document the missing deliverable; screenshots alone do not fulfill an animation demonstration.

Include a compact performance table for baseline and meaningful candidates: cadence/pacing settings, frame interval distribution, long tasks, measured active-message work, event-receipt-to-visible/settled latency, and cleanup/bounded-node findings. State hardware/browser/build, fixture sizes, repeated-run variance and throttling. Explain regressions and compromises rather than hiding them in averages; link representative traces. Separate ordinary and stress results.

The final recommendation must also state validation/review outcomes, immediate-render fallbacks, limitations and deployment status. Update the plan as findings change the recommended path; do not leave the original hypothesis presented as the final design.

## Experiment log and final evidence

Append concise entries during execution; link local recordings/traces when available without committing large generated artifacts or user uploads. Summarize essential numbers here so the decision survives removal of temporary files.

| Experiment / date | Method and hypothesis | Visual result | Performance vs baseline | Decision / next step |
| --- | --- | --- | --- | --- |
| Planning, 2026-10-09 | Reference inspection and current render-path evaluation | Pale leading edge observed in supplied recording | No candidate measurements yet | Proposed; start with baseline, then fades and cadence comparison |

Final evidence and recommendation follow below.

Execution note: `$agent-browser` is not installed in the available skills or local executable paths. Browser evidence uses Playwright bundled Chromium, including recorded video and frame/profile inspection.

### Execution findings

- The benchmark reuses the existing canonical SSE fixture against isolated production builds. Baseline: 1,710-character prose in 73 chunks (45 ms steady; eight-at-once every 360 ms), and mixed Markdown growing from 11,078 to 14,708 characters in 56 chunks. Three runs per case. Headless bundled Chromium on this Mac; recordings affect timing identically across candidates. Baseline artifacts: `tmp/streaming-animation/baseline`.
- Initial prototype comparison exposed a selection listener that unnecessarily cleared fades when the selection was outside the message. That version is rejected; corrected candidates were remeasured. Its videos/numbers are diagnostics, not final visual/performance evidence.
- Correctness polish preserves selected text nodes through fade expiry/append/completion, skips unsafe grapheme boundaries using native segmentation, and only decorates actual canonical deltas via disposable `textDeltaStart` metadata. Canonical replacement clears that metadata. Code, tables and source-transformed text remain immediate.
- Initial browser validation: 17 tests pass (10 new animation tests plus 4 reading-intent and 3 footer tests), covering five input/viewport shapes, fresh-suffix selection, Unicode, replacement/revert/remount, reduced motion and two-tab missed-event refill. The same 17 tests passed again after the final cleanup simplification.
- Cadence candidates: 64, 48 and 32 ms. Early 32 ms measurements show lower receipt-to-DOM latency but more render work, so selection depends on repeated comparisons and throttled/multi-pane checks rather than raw speed alone.
- Animation `finished` promises can reject when nodes are replaced or animations resume at their original age. The recorder reports cancellations; do not mistake cancellation time for measured fade completion. Use predicted remaining duration plus visual/actual final-drain checks, and state this measurement limit.

- Stress-driven simplification: a quiet-period wrapper cleanup causes an otherwise unnecessary full Markdown reparse. Remove that timer and let finished fades become inert; prune on the next actual text update and clear on completion/replacement. This keeps the same visual behavior, bounds retained decoration and avoids extra work while quiet. The final measurements below use this timer-free refinement.


### Recommendation and implementation

Retain the lightly staggered word-run fade and reduce ordinary canonical-event batching from 64 to **48 ms**. It produces a softer leading edge than one fade per chunk and improves receipt-to-DOM latency without the higher update cost of 32 ms. This is a visual judgment supported by matched recordings, not a claim to reproduce ChatGPT internals.

The implementation adds two focused Markdown helpers, no dependencies and no transport changes. A canonical delta supplies a disposable source offset; a prefix check and Markdown source positions identify eligible new text. Native Web Animations fade opacity from 0.25 to 1 over 240 ms, with up to 49 ms of word-group stagger. There is no artificial text queue, per-frame React update, adaptive scheduler or custom parser. At most 16 source ranges are retained, with new decoration limited to the last 1,000 characters; a range can span multiple Markdown text nodes. The measured maximum was 20 simultaneous animations in one pane and 40 in two. Completion, replacement and unmount remove effects; stalled messages retain only inert bounded spans and perform no quiet-period cleanup render.

Keep immediate rendering for code/tables, transformed source such as entities, unsafe grapheme splits, first mount/history/refill, non-append corrections, reduced motion and foreground recovery. Selection cancels motion and preserves selected nodes until deselection, even across completion. First text replacing the existing empty-message placeholder also appears immediately. No backend lifecycle, authoritative state or API contract changed.

### Videos and reproducibility

Open the [comparison gallery](../artifacts/streaming-animation/index.html). It contains matched baseline/final steady and bursty clips, three meaningful alternatives, throttled long Markdown, narrow-pane scrolling, reading-position preservation and adjacent compact/regular panes with typing. Controls support matched playback and scrubbing; content offsets are approximate, not frame-exact synchronization.

Direct clips: [baseline steady](../artifacts/streaming-animation/baseline-final-steady-cpu1.webm), [recommended steady](../artifacts/streaming-animation/final-steady-cpu1.webm), [recommended bursts](../artifacts/streaming-animation/final-bursty-cpu1.webm), [long Markdown at 4× CPU](../artifacts/streaming-animation/final-slow-mixed-long-cpu4.webm), [narrow pane](../artifacts/streaming-animation/final-narrow-mixed-long-cpu1.webm), [reading older content](../artifacts/streaming-animation/final-reading-mixed-long-cpu1.webm), [two panes and typing](../artifacts/streaming-animation/final-two-video-steady-cpu4.webm).

[Reproduction notes](../artifacts/streaming-animation/reproduction.md), raw summaries/profiles linked in the gallery, and the [40-theme contact sheet](../artifacts/streaming-animation/themes/contact-sheet.html) accompany the videos. These are local generated artifacts, intentionally not committed; essential findings remain in this plan. The gallery was smoke-tested in bundled Chromium: all 12 videos decode, all 34 relative links resolve, playback/pause/seek work, and no console errors occur.

### Measurements and decision

Environment: Apple M4, macOS arm64, production Vite builds, Playwright bundled Chromium 147.0.7727.15. Measurements ran sequentially without competing test/build/browser jobs. Ordinary viewport 1280×900; two panes 1440×900 with approximately 350/790 px content widths. Three runs per table row. Prose is 1,710 characters/73 chunks, delivered every 45 ms or eight chunks every 360 ms; mixed Markdown grows from 11,078 to 14,708 characters in 56 chunks. CPU throttle is a stress simulation, not physical-device proof.

Numbers are medians of run summaries; brackets show run ranges. Browser task work includes delivery, rendering, animation, instrumentation and settle/idle observations, not parser-only time. Script time is a subset and must not be added to task work.

| Ordinary fixture / method | Receipt→DOM median ms | Frame p95 ms [range] | Browser task ms [range] | Long tasks per run |
| --- | ---: | --- | --- | --- |
| Steady baseline 64 ms | 66.9 | 26.0 [14.0–27.1] | 248 [223–263] | 0 / 0 / 0 |
| Steady final words 48 ms | 50.7 | 27.1 [16.9–27.1] | 315 [308–327] | 0 / 0 / 0 |
| Bursty baseline 64 ms | 69.9 | 17.5 [16.5–25.2] | 154 [147–157] | 0 / 0 / 0 |
| Bursty final words 48 ms | 52.9 | 16.7 [16.7–26.7] | 190 [186–191] | 0 / 0 / 0 |
| Mixed baseline 64 ms | 63.1 | 16.7 [16.7–25.4] | 333 [326–346] | 0 / 0 / 0 |
| Mixed final words 48 ms | 49.7 | 16.7 [15.4–26.6] | 396 [385–547] | 0 / 0 / 0 |

The separate corrected-candidate sweep compared grouping/cadence before removing the quiet cleanup timer:

| Steady candidate | Receipt→DOM median ms | Browser task median ms [range] | Judgment |
| --- | ---: | --- | --- |
| Chunk fade, 64 ms | 66.9 | 263 [260–285] | Simple, but chunk boundaries pulse more visibly |
| Word fade, 64 ms | 67.2 | 344 [318–366] | Better leading edge; batching latency unchanged |
| Word fade, 48 ms | 51.1 | 280 [268–330] | Best visual/latency compromise; retained and simplified |
| Word fade, 32 ms | 39.4 | 445 [407–526] | About 12 ms quicker than 48 ms, substantially more work; rejected |

Run variance means the isolated 280 ms candidate result is not a reliable claim that the final implementation costs less than 64 ms word fades. The repeated final-vs-baseline measurements establish its actual tradeoff.

The >10% work investigation threshold was triggered. We removed the quiet-period full-Markdown cleanup render, then repeated measurements with video disabled and lighter instrumentation that omits per-mutation animation/node inspection. The extra work remains real:

| 4× CPU stress | Task ms baseline→final | Frame p95 ms baseline→final [run ranges] | Long tasks baseline→final | Receipt→DOM median ms baseline→final |
| --- | --- | --- | --- | --- |
| Light probes, steady | 335→450 (+34%) | 25.4→18.4 [18.4–25.5 / 18.1–25.4] | 0/0/0→0/0/0 | 66.8→51.9 |
| Light probes, bursts | 209→262 (+25%) | 18.1→16.3 [16.7–18.1 / 15.1–27.1] | 0/0/0→0/0/0 | 73.0→58.1 |
| Light probes, mixed | 708→901 (+27%) | 27.2→27.3 [27.1–27.6 / 27.2–27.3] | 2/1/1→2/2/1 | 84.5→78.9 |
| Two panes + typing, steady | 822→1145 (+39%) | 25.6→25.7 [25.4–25.8 / 25.6–26.0] | 0/0/0→0/0/0 | 72.3→57.0 |
| Two panes + typing, mixed | 1553→1856 (+20%) | 55.6→60.0 [53.8–55.6 / 59.2–61.1] | 15/15/15→15/15/15 | 119.1→112.2 |

Two-pane typing-to-next-frame p95 medians were 21.1→16.2 ms for prose and 17.0→16.1 ms for mixed Markdown; the complete typed draft survived. These are synthetic browser-input measurements, not physical keyboard latency. Heavy two-pane Markdown already exceeds a frame budget; final p95 is approximately 8% worse. This is an accepted limitation, not universal 60 fps. The additional work was judged acceptable because ordinary prose adds no long tasks, repeated lightweight stress measurements do not show material frame/input degradation, and the implementation has zero continuing quiet work. Extra CPU/battery cost remains a tradeoff; the highest proportional work increase is explicitly retained above.

A targeted production CPU profile measured roughly 898→987 ms sampled non-idle work (+10%) across approximately 4.28 s. It is a single corroborating sample, not a substitute for repeated measurements. Shared minified bundles dominate both profiles; module-inclusive stacks overlap and do not isolate Markdown parsing. Full-message Markdown parsing remains unchanged and is a likely contributor to the existing stress limit; a parser rewrite is not justified by this experiment.

Final actual last-receipt-to-settled medians: ordinary steady 316 ms, bursts 305 ms, mixed 325 ms; 4× mixed 343 ms; two-pane mixed 385 ms. These include event batching/rendering. Compared with baseline final-drain medians, added delay is approximately 233–242 ms, inside the 300 ms added-delay target. The animation itself adds at most 289 ms by construction. Completion/interrupt does not wait for it. Per-event predicted settling is separately labeled in raw data; canceled animation promises are excluded from observed settling, never counted as successful completion.

Peak measured message DOM was 616 nodes versus 601 settled nodes for the long fixture; two panes peaked at 1,234 and returned to 1,202. All cleanup observations found zero running animations. Browser tests additionally hold a stalled stream past settling and verify no DOM mutation or running animation. No claim is made that rAF timings prove exact pixel latency: headless cadence varies, videos are 25 fps, and receipt-to-DOM coverage excludes some tiny/syntax-only chunks (72/73 prose, 49/56 mixed).

### Validation and review

- Final focused unit/component suites: 63 passed, one existing opt-in benchmark skipped; canonical payload suite: another 4 passed. Includes Markdown semantics, Unicode, selection/visibility/reduced-motion recovery, delta provenance, canonical batch ordering, scheduler cancellation and read-only consumers.
- Final browser run: 17 passed, including 10 animation tests, 4 reading-intent tests and 3 footer tests. Five input/viewport shapes, selection/copy text continuity, resize, canonical replacement/revert/remount, reduced motion, and same-user two-tab missed-event refill are covered.
- All 40 supported themes captured with live streaming; contact sheet visually reviewed. No shared theme/control mapping changed.
- Production build/typecheck and frontend trim pass. Existing bundle-size advisory remains; no new dependency. No fixture, unexpected API or console errors in recorded comparisons.
- Independent review covered provenance/reconciliation, Unicode and Markdown, selected-node lifetime, visibility recovery, timer removal, scheduler consumers, final performance evidence and gallery playback. Findings were fixed and relevant checks rerun. Review accepts the measured work tradeoff, with no outstanding material correctness finding.
- No deployment, backend change, API/schema change, persistent setting, production profiling hook or experimental switch. Before deployment, the user can judge the supplied motion clips; deployment remains a separate task. Real-device battery/thermal behavior and non-Chromium browser performance are unmeasured.
