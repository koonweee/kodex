# Streaming Assistant Text Animation

## Status and objective

Proposed. Planning only; no animation implementation or current performance measurements yet.

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

Status: Pending.

- Inspect existing Playwright fixtures and local performance helpers first. Reuse their canonical event/snapshot path; add only a small deterministic replay helper if needed, not a benchmark platform.
- Capture short prose resembling the reference, a long multi-screen answer, and mixed Markdown with headings, emphasis, links, lists, fenced code and a table.
- Use identical text and timing for baseline/candidates: steady small chunks, bursts separated by pauses, and a fast burst followed by completion. Record fixture sizes, delivery cadence, browser/build, viewport, hardware and CPU throttling.
- Use a production frontend build for performance comparisons. Warm it consistently and run each performance-critical baseline/candidate scenario three times; report medians and ranges rather than a single favorable run.
- Capture frame intervals/missed-frame proxy, main-thread long tasks, active-message render/parse cost using a targeted profile, and time from canonical text arrival to visible and settled text. Check animated-node/timer growth and cleanup. Avoid invasive instrumentation in every sample.
- Establish baseline scroll-follow behavior and responsiveness while typing in the composer during streaming. Historical artifacts may suggest scenarios, but are not a measurement of this checkout.

Exit: a small repeatable fixture set, a baseline recording/profile, and baseline-confirmed comparison budgets recorded here. Do not block exploration on perfect instrumentation.

## Stage 2: Compare small visual methods

Status: Pending.

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

Status: Pending; run only for the retained method.

Keep the animated suffix and its metadata bounded by a short lifetime/size. Clean up settled work without breaking selection, restarting old animations or accumulating timers. Avoid per-frame parent timeline state updates. Canonical replacements win immediately; no queued visual callback may resurrect obsolete text.

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

Status: Pending.

Run the retained candidate against the same baseline fixtures, including a long answer, mixed Markdown, multiple streaming panes and CPU throttling. Use recordings for visual judgment and profiles for cost; a pleasant short prose example alone does not establish success.

Initial decision budgets, to confirm against baseline variance in Stage 1:

- Aim for fluid animation within the display's frame budget on the ordinary desktop fixture (16.7 ms at 60 Hz). On throttled/long-answer fixtures, compare with baseline rather than claiming universal 60 fps.
- Investigate a repeatable >10% increase in p95 frame interval or active-message main-thread work, any added recurring >50 ms tasks, or input/scroll degradation. If noise exceeds that threshold, collect a targeted trace/repeat; do not silently waive the comparison. Simplify or reject if the regression remains material.
- Do not add intentional delay before the first visible text in A/B. Target <=300 ms added arrival-to-settled time; any optional reveal buffer must catch up within that same budget under bursts, or snap immediately. Measure end-to-end event-receipt-to-visible latency as well as presentation delay so changing the flush cadence cannot hide latency in the accounting. Completion/interrupt/foreground recovery must not wait for it.
- No animation-driven full-message Markdown parse every frame. Animated DOM and scheduled work must stay bounded as the answer grows and return to baseline after settling/unmount; zero continuing animation work when idle/hidden.

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

Final evidence to fill: fixture/build/environment details, baseline/candidate metrics and variance, chosen method/tuning, browser matrix results, tests/build/trim, independent review, remaining limitations and deployment status.
