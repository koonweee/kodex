# Responsive UI Contract and Classification Cleanup

## Status

Complete. Initial contract, idle compact composer and compact radius/loading refinements are validated and deployed. Created 2026-10-08.

## Objective

Make UI treatments follow explicit, independent characteristics of their available space and input environment. A narrow desktop pane should reuse the current compact mobile presentation without acquiring touch-only interaction behavior. Components must consume shared classifications rather than invent a local definition of "mobile".

Retain the existing native/gateway ownership of conversation, settings, queue and lifecycle state. Responsive classification, disclosure choice and editing presentation are intentionally local to each browser/pane.

## User Decisions

1. Automatic fullscreen composer expansion requires an **actual touch interaction that opens the composer** and the device-local Interface preference to be enabled. It applies at any browser width by default. Mouse or keyboard focus stays inline, including on a touch-capable computer; disabling the preference keeps every opening inline.
2. Compact panes reuse the **current mobile treatment** for composer controls, attachments and annotations. Do not invent a new toolbar redesign or replace it with an all-controls-wrapped layout. Separate its layout rules from touch ergonomics.
3. **Keyboard-submit behavior remains unchanged.** Hybrid keyboard shortcuts are a separate follow-up, not an implicit consequence of classification cleanup. In particular, do not change Enter, Shift+Enter, Meta+Enter, queue submission or IME handling as part of this plan.
4. Scope includes shared enforcement and cleanup of existing classifications. Implementation and full frontend/backend deployment were subsequently requested.

## Current Evidence and Gaps

- `src/shared/inputCapabilities.ts` owns capability reads and subscriptions. Touch availability and fine hover can both be true. Its `hasCoarsePointer` combines primary and any coarse pointer; it is not evidence that a particular interaction was touch.
- `src/shared/layoutBreakpoints.ts` defines the 900px workspace breakpoint. Shell and composer repeat subscriptions around it.
- `src/composer/ComposerPanel.tsx` chooses the mobile representation from viewport width plus touch capability. Goal compactness uses viewport width alone.
- `src/composer/InlineComposerPanel.tsx` already shares the actual composer UI. Its `desktop/mobile` density flag also controls annotation defaults.
- `src/styles/mobile-composer.css` mixes fit changes (padding, bounded controls, attachment tray) with touch concerns (input sizing, safe areas, fullscreen keyboard geometry).
- `src/composer/useCompactComposer.ts` actually measures pane **height** below 600px. `QueueDisclosure` uses it for a local default, with an explicit user choice taking precedence.
- Message image sizing, question stacking and composer heading sizing use viewport breakpoints. The subagent viewer uses viewport-based split sizing and replacement despite living inside a pane.
- Automation/editor and preview flags such as `isMobileModal`, `isCompact` and `isDesktopPreview` often describe available space, not input capability.
- The existing inline textarea starts at two rows and grows to five regardless of pane height. Preserve that contract; this plan does not reopen composer autosize behavior.
- `plans/touch-responsive-styling.md` already establishes width versus touch separation. `plans/mobile-composer.md` contains historical descriptions and checks that no longer match current code. Keep their completed history, but explicitly supersede conflicting future guidance with this contract when implementing it.

Paths above are relative to `apps/web` unless prefixed with `plans/`.

## Classification and Ownership Contract

| Fact | Owner/classification | Permitted uses |
| --- | --- | --- |
| Browser layout width | Shared workspace layout (`single-panel` / `docked`, naming illustrative) | Sidebar/navigation, workspace arrangement and global overlay fit |
| Available pane width | Shared pane layout (`compact` / `regular`) | Composer density/accessories, goal presentation, stacking, message/media fit and pane-contained views |
| Available pane height | Shared pane height constraint (`short` / `regular`) | Existing queue default and bounded accessory/scroll regions; not input modality |
| Input capabilities | Existing shared capability module | Touch targets, hover alternatives, capability-dependent controls |
| Actual input event | Owning interaction handler, using `PointerEvent.pointerType` | Touch initiation, drag/hold behavior, fullscreen composer activation |
| Visual viewport/safe area | Existing keyboard/viewport helper and CSS environment values | Geometry of eligible expanded editing UI; never proof of touch or a hardware keyboard |

A treatment has one owning rule. Combinations are explicit domain policies, not a global device label. Examples: `compactPane`, `shortPane`, `canHover`, and `shouldExpandComposerOnTouch` describe the decision; `isMobile` and `isDesktop` do not.

Input facts must distinguish **primary** from **available** capability. Today `hasFineHover` means primary fine pointer plus primary hover, while `hasCoarsePointer` includes any available coarse pointer. M1 must document and name these semantics explicitly; add available-hover facts only where a real consumer needs them. Do not infer the current input event from either set of capabilities, or silently change the legacy submission helper while clarifying the names. Validate both fine-primary + touch and touch-primary + secondary mouse/trackpad combinations.

No UA sniffing or inferred hardware-keyboard detection. Touch availability must not disable mouse/keyboard affordances. Reduced motion, color scheme and forced colors remain independent existing concerns, not new members of a device taxonomy.

### Shared implementation seam

- Extend the existing layout/capability modules rather than add a parallel system.
- Introduce a shared pane-layout boundary that measures the containing pane once and exposes the same width/height classifications to React and scoped CSS attributes. Use native ResizeObserver and update consumers only on classification transitions, not every pixel.
- Keep breakpoint ownership in the shared layout layer. Do not independently copy behavior thresholds into feature hooks or CSS. Prefer ordinary flex/grid/wrapping for fit within a class. If a purely visual container query is necessary, give it a named owner and concrete fit justification; it must not redefine the shared pane class.
- Measure available layout space in CSS pixels, not physical screen resolution. Measure the stable pane allocation, not the textarea or an accessory whose size changes in response to the rule. Hidden/unmeasurable panels must not cause resize loops or reset user choices.
- Each pane has independent layout state. A compact pane must not change a spacious sibling's treatment. Nested surfaces must use the intended nearest owner without inheriting another pane's compactness accidentally.
- Global overlays use viewport fit; pane-owned portals receive any required presentation policy explicitly. Do not assume DOM ancestry across a portal.
- Keep policy helpers small and domain-owned where appropriate. Avoid a universal object with flags for every feature, persistent responsive preferences, or a new styling framework.

### Threshold selection

Retain the existing 900px workspace boundary and existing below-600px short-pane queue behavior initially. Select the compact-pane width cutoff during M1 using actual current mobile controls/content fit and representative pane sizes. Do not copy 900px merely because it already exists. Record the selected cutoff and evidence before migrating callers; choosing that measured value is an implementation decision, not another approval gate.

Start with two width classes and a separate height constraint. Add another class only if concrete content-fit evidence cannot be handled by normal wrapping or the existing classes. Do not redefine every historical 640/700/760/900px threshold to one number without checking the owning surface.

## Interaction Rules

### Composer

- Compact density applies from pane width on both fine-pointer and touch-capable devices. Reuse current compact control labels, accessory layout, attachment tray and annotation defaults, while preserving all existing actions.
- Touch targets, editable-input zoom avoidance and safe-area treatment stay capability-owned. Fullscreen layout/keyboard adjustment is separate from compact density.
- Automatic expansion is initiated by a touch interaction opening an editable composer field when the device-local Interface preference is enabled. Capability flags alone, mouse clicks, Tab focus, programmatic autofocus and resize must not trigger expansion.
- Handle tapping an already-focused editable field, not just its first focus event. Avoid a global "last input was touch" flag that can make unrelated later focus expand the composer.
- Preserve the directly focused textarea through expansion and all responsive changes. No alternate keyed subtree that remounts input on a width/capability transition. Preserve selection, IME composition, annotations, skill bindings, attachments and draft identity.
- Preserve explicit collapse and submit behavior. Width changes must never expand or collapse an active composer. Keyboard visual-viewport changes size an existing expanded composer; they are not activation signals.
- Preserve current anchored settings menus versus touch-sheet behavior through a named policy. A compact fine-pointer pane retains anchored menus. Do not make every fullscreen modal in the app touch-only: some global dialogs use fullscreen for viewport fit.
- Keep all existing keyboard-submit semantics, including the current touch-capability-dependent branch, under an explicitly named legacy submission policy if renamed. Test preservation; do not derive it from the new compact/fullscreen flags.

### Disclosures, previews and other panes

- Preserve manual queue disclosure choice across resizing; pane height only determines the untouched default. Keep the two-to-five-row inline textarea contract.
- Preserve annotation editing and deliberate disclosure state when moving between densities; compact defaults must not repeatedly collapse active content on every resize.
- Move pane-owned message images, question-choice stacking, heading sizing and subagent split/replacement to pane space. Use current narrow treatments as the visual baseline.
- Subagent viewing must remain usable in a narrow pane inside a wide workspace, with an accessible route back to the parent transcript. Observer/history semantics stay unchanged.
- Terminal touch accessories, touch holds and hover alternatives retain their capability/event ownership. A narrow fine-pointer terminal must not acquire touch-only accessories.
- Audit automation prompt split/tabs, modal fit, Markdown previews, preferences and generated-app hosts for correct ownership. Rename misleading classifications and consolidate detection, preserving intentional behavior outside the pane/composer changes above. Do not change embedded generated-app internals.

## Enforcement

1. **Code structure:** shared fact owners, one pane boundary and small named behavior policies. No feature-local capability discovery or competing pane-width observers.
2. **Contributor guidance:** update AGENTS.md's responsive section with the ownership table, examples, portal rules, hybrid-input caveat and required test matrix. Add focused explanatory prose to existing architecture/development docs rather than another competing contract.
3. **Static guard:** add a small architecture-audit command to the frontend check/trim workflow. Reject direct `navigator.maxTouchPoints`, capability `matchMedia`, and ad hoc behavioral width detection outside explicit shared owners. Include bypasses through Mantine media-query hooks in the audit. Allow actual pointer-event checks, browser geometry for placement, and unrelated appearance/accessibility queries.
4. **CSS review:** migrated pane feature styles must not use viewport breakpoints for pane fit. Keep any audit exceptions explicit, narrow and explained. Do not add a broad lint framework or snapshot/regex tests asserting CSS declarations or breakpoint numbers; use a targeted source guard for architecture violations and behavioral browser checks for treatment correctness.
5. **Review:** each implementation chunk gets an independent review. Check correct axis/owner selection, capability combinations, resize continuity, portal behavior and removed obsolete helpers/selectors.

Static enforcement catches bypasses, not design intent. Browser acceptance scenarios remain necessary.

## Implementation Milestones

### M1 — Shared contract, pane boundary and guard

- Inventory current responsive decisions and assign each an owner, including legitimate viewport-driven overlays.
- Record the measured compact-width cutoff and reuse the existing workspace/short-height boundaries where appropriate.
- Consolidate shared layout subscriptions and provide pane classes to CSS/React without per-pixel React updates.
- Add the narrow-workspace + actual-touch composer activation policy, initially with focused tests.
- Add the architectural guard and contributor guidance. Document intentional exceptions and unchanged submission behavior.

Exit: meaningful helper/policy tests pass for independent pane sizes, capability combinations and actual touch versus mouse/keyboard initiation; guard catches prohibited detection with useful locations and runs in the normal frontend workflow. Existing behavior remains runnable before migration.

### M2 — Composer and accessories

- Separate compact presentation, height constraints, touch ergonomics and fullscreen activation.
- Replace density names and the misleading height-based compact helper; remove superseded selection/subscription paths.
- Reuse existing mobile visual treatment for narrow desktop panes.
- Preserve input identity, drafts, focus and editing context across resize, rotation, expansion and collapse.
- Preserve keyboard-submit behavior, queue routing and textarea autosize.

Exit: wide workspace with a narrow fine-pointer pane gets compact UI but never automatic fullscreen; actual touch opening expands by default at any workspace width; the device preference can retain inline composition; mouse/keyboard/programmatic focus remains inline. Existing keyboard, annotation, skill, attachment and queue behavior tests pass.

### M3 — Pane content and classification cleanup

- Migrate message/media fit, question choices, headings and subagent viewer layout.
- Normalize sidebar/shell classifications, terminal affordances, automation editor, previews, preferences and generated-app host fit where the inventory identifies misleading ownership or duplicated detection.
- Preserve legitimate viewport rules and overlay behaviors; no unrelated visual redesign.
- Delete obsolete selectors/helpers/tests tied solely to old classifications. Retain behavior coverage and intentional legacy keyboard behavior.

Exit: the inventory has no unexplained classifications; adjacent narrow/wide panes behave independently and all actions remain reachable. Global overlays and touch controls still follow their documented owners.

### M4 — Cross-combination validation and documentation

- Extend existing domain/component and Playwright suites; prefer the existing mobile-composer, composer-pane-height, settings-menu, annotation, goal, terminal and workspace fixtures.
- Complete the matrix below, visual review and independent final review.
- Update architecture/development guidance and mark historical plan guidance superseded without rewriting completed historical results.
- Update this plan and plans/index.md only after exit criteria are satisfied. Commit coherent tested chunks; the subsequent user request authorizes full deployment after validation.

Exit: all required tests, build/typecheck and frontend trim/architecture guard pass; relevant browser screenshots are reviewed; known physical-device limitations are recorded, not claimed as passed.

## Validation Matrix

| Shape / transition | Required evidence |
| --- | --- |
| Wide fine-pointer browser, compact pane beside regular pane | Compact mobile visual treatment only in constrained pane; inline composer, keyboard behavior, no overflow |
| Narrow fine-pointer browser | Single-panel shell and compact fit; mouse/Tab/programmatic focus never auto-fullscreen |
| Narrow touch browser | Direct touch opening expands the existing textarea by default; keyboard/safe-area handling and Send/Stop remain usable |
| Wide touch browser with narrow pane | Compact fit and touch affordances; touch opening expands by default while capability or pane width alone never does |
| Hybrid touch + fine hover in narrow browser | Mouse/keyboard focus stays inline; actual touch opening expands; hover and non-hover routes coexist |
| Width breakpoint crossings during editing | Same DOM textarea, focus, selection, IME, draft/attachments/annotations/skill state retained; no new auto-expansion |
| Independent height resize, including four-pane layout | Existing two-to-five textarea rows preserved; queue defaults respond to short height, manual choice retained |
| Hidden tab/dock reveal and pane relocation | Correct classification on reveal; no zero-size reset, observer leak or resize feedback loop |
| Portalled menus and nested previews | Intended owner retained, menus fit, no compact fine-pointer bottom sheets |
| Long content and keyboard viewport shrink | Wrapping/scrolling works; focused editor and actions remain reachable; no unexpected console errors |

Use Playwright's bundled Chromium for desktop fine-pointer, narrow fine-pointer and touch shapes; use agent-browser alongside it when available as required by repository guidance. Do not launch installed Google Chrome from the gateway. Physical iOS keyboard and hybrid-device behavior may need manual validation; emulation must not be presented as proof of those environments.

Tests should protect decisions, accessibility, input continuity, actual rendered fit, resizing and interaction. Do not add low-value tests of CSS strings, class names, chosen breakpoint constants or token wiring. Appearance/contrast gates are required if implementation changes shared control mappings or semantic color pairings; this plan does not request palette or theme changes.

Run relevant domain tests, `cd apps/web && npm run build`, and `./tools/trim-frontend.sh` (including the new architecture guard). Responsive state is per-tab; no new gateway or two-client synchronization machinery is warranted. Keep existing native settings/input convergence coverage intact.

## Exclusions and Coordination

- No gateway/app-server, OpenAPI, persistence, queue-routing or read/unread changes.
- No new device taxonomy, user-agent detection, animation framework, breakpoint generator or persistent responsive state.
- No keyboard-shortcut redesign or hardware-keyboard detection.
- No changes to docking persistence, thread scroll/reading-intent policy, core composer autosize or generated-app internals.
- Full frontend/backend deployment is authorized by the subsequent explicit user request. Use the macOS service updater after validation, and verify its independent operation succeeds.
- Concurrent work currently touches timeline scrolling, message rendering and reducer behavior. Re-read the latest checkout before implementation, coordinate overlapping files and preserve those changes. Do not absorb unrelated workspace edits into this plan's commits.

## References

- [Plans index](index.md)
- [Touch and narrow viewport styling](touch-responsive-styling.md)
- [Mobile composer](mobile-composer.md)
- [UI standardization](ui-standardization.md)
- [Contributor rules](../AGENTS.md)
- [Architecture](../docs/architecture.md)
- [Development and verification](../docs/development.md)

## Implementation Decisions (2026-10-08)

- Pane density uses a 640px width boundary and short height remains below 600px. The compact treatment fits a 360px desktop column beside a regular pane; both retain independent composer density, attachments and inline focus. Workspace layout remains 900px; global compact dialogs retain 700px.
- Every pane owner exposes `data-pane-width` and `data-pane-height` from one border-box ResizeObserver. React classification changes only across boundaries; hidden zero-size observations retain the previous useful classification. Nested transcript and prompt-editor owners reset their inherited fit variables.
- Browser breakpoint continuity requires keeping the Dockview render tree mounted. Narrow layout uses native group maximization plus the existing pane-manager header. Its temporary maximize marker is not saved as a user layout preference; desktop proportions and explicit maximize choices are preserved.
- Remaining viewport rules are intentional for global preferences, the workspace sidebar/single-panel chrome, automation tables/dialogs, and generated-app host chrome in the single-panel workspace. Generated-app interiors are unchanged. Terminal geometry follows its allocated pane; touch accessory controls remain capability-owned.
- Keyboard submission remains the existing `isTouchInputDevice` policy, with a source comment documenting the separate future hybrid-shortcut decision. Fullscreen activation uses the actual editable-field pointer event instead.
- The TypeScript-based architecture check is part of `npm run trim`. It rejects feature-owned responsive media/input detection and viewport-fit CSS in migrated pane-only styles; appearance queries and placement geometry remain valid.
- Browser validation uses bundled Playwright Chromium because agent-browser is unavailable in this environment. Physical iOS keyboard and hardware hybrid behavior remain manual verification limits.

## Validation Results

- Frontend: 159 unit/component suites, 1,146 tests passing and one pre-existing skipped test. The stable full run passed 1,145 tests; the remaining immediate composer lookup was changed to await its asynchronous mount, and all 19 tests in that suite passed on rerun.
- Browser: all 41 relevant Chromium cases pass across the serial matrix and focused reruns. This includes narrow fine pointer/touch/hybrid activation, wide-touch inline behavior, compact/regular siblings, native split-size restoration, same textarea/focus/selection through width changes, two-to-five rows and four-pane heights, question/image fit, subagent return paths, portaled menus, annotations/queued quotes, terminal presentation, tab geometry and history/bottom scroll continuity. Existing two-tab snapshot/SSE convergence checks remain intact.
- Production frontend build, typecheck, unused-code/dependency checks and all 11 architecture-check fixtures pass. Backend test suites pass (650 library tests plus four integration tests; existing ignored suites remain ignored), and backend trim passes.
- Browser screenshots were reviewed for compact composer versus regular sibling, stacked question choices, touch layouts and subagent fit. Independent source/fixture reviews completed with all findings resolved.
- Several prior native-input/acknowledgment test fixtures were stale: updated exact Send payloads, canonical client correlation, asynchronous mount waits and queued-quote editor inspection without changing application semantics. Tab tests explicitly establish a single tab group because workspace placement can legitimately allocate two columns.
- Tests using a stale Vite server or during source HMR/CPU contention were discarded. Final evidence uses this checkout and bundled Chromium with frozen source. The terminal harness's transient missing Vite prebundle passed on a fresh isolated server.
- Physical iOS keyboard and real hardware hybrid interaction are not claimed as validated by Chromium emulation.

## Deployment Verification

Full macOS service update from implementation commit `a43072d` completed successfully. Operation `94b21d09d04f413a8fb117084ab562af` reports `succeeded`; selected release is `20261008-012419-7e5c6a05`. Live `/readyz` reports ready, the native runtime matches schema `0.160.0`, and the served frontend index matches the installed release byte for byte. Local/VPN deployment assumptions are unchanged.

## Follow-up: idle compact composer

Complete. The user authorized implementation and frontend-only deployment on 2026-10-08; both are verified.

- All compact panes qualify, and touch-capable regular panes also qualify; only existing conversations collapse. New-conversation greetings and project controls retain their current presentation.
- When empty and inactive, the composer keeps its four corner radii and becomes one footer-height row. The same single-line textarea occupies the space between attachment and context/settings controls. All footer actions, including Stop, remain available.
- Compact panes replace the model/effort text with a brain icon, retaining the complete accessible label and tooltip. Regular panes retain the text.
- Editable focus restores normal inline height. Actual touch opens the existing fullscreen composer at any workspace width when the device preference is enabled; mouse, keyboard and programmatic focus remain inline.
- Before submission captures the payload, text (including whitespace), attachments, annotations, skill bindings, drag/drop and settings errors prevent idle collapse. Empty inactive compact panes keep idle presentation through entry/settings loading or settings updates, with existing readiness and disabled-control guards. Focus moving through the composer and its portalled menus preserves an active editing session.
- Preserve textarea identity, selection, IME and drafts across every transition. This is per-pane presentation; native submission, queue and settings ownership remain unchanged.

Exit: focused behavior tests, bundled-Chromium layout/input/menu/resize checks, build/typecheck, trim and independent review pass; deploy a committed frontend snapshot without restarting the gateway, and verify the served bundle. This follow-up supersedes the two-row minimum only for eligible idle existing conversations.

Validation also exposed an existing native Dockview resize defect: hidden split allocations are absolute, and restoring them at narrow or transient sidebar-animation bounds changes their proportions. The responsive session records only its entry container dimensions. Native reveal and serialization temporarily use those bounds before restoring current geometry; native proportional resizing remains authoritative. Narrow entry cancels pending saves, delayed callbacks check current mode, and reconciliation serializes once through the same helper. Real Dockview core regressions cover resize, narrow serialization and delayed saves. The rendered browser test waits for the sidebar to settle while preserving the same per-group baseline and tolerance. No split ledger or renderer replacement was added.

Composer menus restore their existing trigger synchronously before reporting closed, so focus gaps during portalled menu navigation cannot prematurely end editing. Native settings-save disabling remains intact. Touch opening focuses the existing editable field within the gesture and prevents pointer defaults from disturbing focus during relayout; already-expanded taps retain ordinary cursor/selection behavior.

## Follow-up: device fullscreen composer preference

Complete, validated and deployed frontend-only. This decision supersedes the earlier narrow-workspace requirement and the historical wide-touch-inline validation above.

- The Preferences section named Appearance is now presented as **Interface**. Theme controls remain there alongside device-level interaction choices.
- **Open composer fullscreen when using touch** defaults on. With it enabled, an actual touch opening expands the existing composer at any workspace width. With it disabled, every opening remains inline. Mouse, keyboard and programmatic focus always remain inline.
- The choice is browser/device-local in `localStorage` and converges across tabs in the same browser. It is not shared through gateway or account state.
- Idle presentation is a separate decision: an empty, inactive composer for an existing conversation is idle when its pane is compact or the browser reports touch input, regardless of the fullscreen preference.
- Resizing never initiates expansion or collapses an active fullscreen composer. In a multi-pane workspace, fullscreen remains pane-owned; in a single-pane workspace it also replaces the workspace header.
- Keep the textarea mounted and preserve focus, selection, IME composition, draft content, annotations, skill bindings and attachments through every transition. Keyboard submission and shared conversation state remain unchanged.

Validation: 84 focused unit/component tests and 43 bundled-Chromium cases pass, including default and opt-out touch opening, mouse/keyboard inline opening, same-browser two-tab preference convergence, annotations, idle motion, compact/regular panes and a four-pane visual-viewport overlap case. Production build/typecheck, frontend trim and all 11 responsive ownership fixtures pass. Independent review found and verified fixes for pane-relative keyboard clipping and idle-selector specificity; rendered checks preserve balanced 8px idle padding and the 32px idle radius.

Deployment: clean snapshot `6381857` was installed with the frontend-only updater onto release `20261008-024630-3ef10fff`. Gateway PID `45933` remained unchanged, `/readyz` reports ready and the served index matches the clean build.

Separate pre-existing follow-up: activating another hidden native group while the workspace is narrow can exit maximize before the client receives the active-panel event and alter split allocations. This change addresses width transitions and serialization; wrapping native group activation is outside the idle-composer scope. Physical iOS keyboard behavior was not revalidated; touch and hybrid evidence uses bundled Chromium.

Follow-up validation: 200 focused composer tests and 43 native workspace tests passed. All 24 bundled-Chromium cases passed across the combined run (21) and targeted rerun (3) after synchronizing the outside-menu check and replacing obsolete programmatic-fullscreen assumptions in touch-queue tests. Coverage includes adjacent pane resize, textarea identity/focus/selection, fine/touch/hybrid activation, menus, footer controls, and native queue convergence across two tabs. Production build/typecheck, full frontend trim including 11 responsive-ownership fixtures, and independent implementation/test review passed. Frontend-only deployment succeeded from clean compatible snapshot `db89578` (main implementation commits `e1889d5` and `f21ab5a`). The installed release remains `20261008-012419-7e5c6a05` and gateway PID `86621` is unchanged; `/readyz` is ready. Served HTML and both entry assets match the built snapshot byte for byte. Index SHA256: `237f6df0e22d541bd4a78f9d973a42f561368542f706b4f7007c7902ba7919f0`. Other ongoing checkout work was excluded from this frontend-only deployment.

Idle-row alignment refinement (2026-10-08): the user requested “build thing” only while idle compact, a vertically centered single-line placeholder, and 8px above and below the controls. Idle-only line heights match fine/coarse control heights; active editing and fullscreen typography remain unchanged. Independent review and 11 Chromium layout/input/height checks passed for this adjustment, along with build/typecheck and trim. The final frontend deployment uses the current API-compatible release, including other already-deployed committed frontend changes.

Alignment refinement deployment verified: frontend snapshot `b044ec1` was deployed onto release `20261008-024630-3ef10fff` with gateway PID `45933` unchanged and `/readyz` ready. Served HTML and both entry assets match the clean snapshot; index SHA256 `d3385bbc59fca0cf49a9c4a5aff21a82f11eb5ddcf941da40361843684f6ff79`. The current API-compatible snapshot again passed all 11 Chromium composer/height checks, build/typecheck and trim. The successful full operation `c5000bfcb5b140ebb7bc67315838b5f1` had already deployed `15f853a`; no committed or working-tree backend/controller differences remain from that source.

Compact-row radius refinement (2026-10-08): the user requested 32px only for the idle compact composer. A dedicated shared corner token applies at that mode selector; active inline composers retain 24px and fullscreen styling retains its existing policy. This supersedes the earlier equal-radius assertion across idle/active transitions, so that obsolete styling assertion is removed while geometry, activation, input identity and menu coverage remain. Frontend-only deployment is authorized.

Compact loading refinement (2026-10-08): empty inactive existing-chat panes retain the idle row during native attachment and settings reads/updates. Drafts, attachments, active editing and errors retain normal presentation. Only the visual predicate changes; native submission/settings ownership, readiness attributes, input identity and disabled controls remain unchanged. Three focused loading regressions failed before implementation. All 32 composer component tests and 16 bundled-Chromium idle/fullscreen cases pass, including held initial attachment/settings responses for fine pointer and touch. Build/typecheck, frontend trim and all 11 responsive ownership fixtures pass. Independent review found no blockers. The authorized frontend deployment is verified below.

Radius/loading refinement deployment verified: clean snapshot `17cbe82` deployed frontend-only onto release `20261008-024630-3ef10fff`. Gateway PID `45933` is unchanged and `/readyz` reports ready. Served HTML and entry JavaScript/CSS match the installed assets and tested build byte for byte; index SHA256 `e61daf0c2b974af57d10bd335c82a36376949755a1aa6a0d0b9e87716a2aac29`. Loading and ready compact-row screenshots were reviewed for fine pointer and touch. Initial browser holds were corrected to gate replacement requests from Strict Mode; all loading cases pass with explicit readiness and disabled-control assertions. Backend code and shared submission/lifecycle ownership are unchanged.

## Follow-up: subtle inline composer motion

Implemented, validated and deployed frontend-only on 2026-10-08. The user requested the inline transition first, with subtle motion and no bounce or overshoot.

- Eligible compact existing-chat composers morph between idle and active inline presentation over 180ms with native easing. The bottom edge remains anchored. Effective corner radii account for short-pill normalization while easing between the existing 32px/24px treatments.
- A decorative fill scales independently while a separate bottom-anchored shadow layer animates its height and radius without scaling the blur. Both use the existing composer surface and shadow values. Input and footer groups translate without scaling text or icons; the textarea remains mounted, focuses immediately and accepts typing during motion. There are no animation-frame React updates or new dependencies.
- Rapid reversal starts from eased native progress. Native overrides clear at completion, resize/autosize changes, loss of inline eligibility, live reduced-motion changes and unmount. Fullscreen and regular/new-chat presentations keep their existing immediate behavior. Drag/drop dims contents while retaining the raised surface.
- Motion is intentionally per-pane/per-tab visual state; native submission, settings, queue and shared lifecycle ownership are unchanged.

The initial rendered regression failed with zero intermediate expansion frames before implementation. All 38 focused component/controller tests and 22 bundled-Chromium composer cases pass. Coverage includes immediate typing, same-node focus/selection, smooth bounded growth and control movement, reversal continuity, resize, reduced motion, menus, loading, fullscreen and wide-touch inline behavior. Fine-pointer and touch expansion yielded 10 and 12 intermediate frames respectively with zero bottom-edge drift. Light/dark screenshots and sampled geometry were reviewed. Production build/typecheck, frontend trim and all 11 responsive-ownership fixtures pass; independent source/test review found no remaining blockers. Physical iOS keyboard rendering is not claimed as validated by Chromium emulation.

Frontend deployment verified from clean snapshot `1c27050` onto release `20261008-024630-3ef10fff`. Gateway PID `45933` remained unchanged and `/readyz` reports ready. Served HTML and entry JavaScript/CSS match the installed assets and clean build byte for byte; index SHA256 `a2f8b310b9dc9489217a1a2a4b5500df0a7724afb34ca0bf23860d6f13c9e3f1`. Uncommitted submission/shortcut, API, test and documentation work in the main checkout was excluded from deployment.

Shadow stability refinement (2026-10-08): the endpoint shadows were already identical, but scaling the single painted surface compressed and re-rasterized its bottom shadow during intermediate frames. The shadow now occupies its own unscaled layer and tracks the fill’s bottom edge, height and radius while preserving one computed blur/offset throughout. The rendered regression failed before implementation and now verifies constant shadow styling, no shadow scale, less than 1px fill/shadow height divergence and less than 1px bottom drift. All 39 focused component/controller tests and 22 bundled-Chromium composer cases pass; build/typecheck, trim, all 11 responsive-ownership fixtures, screenshot review and independent source/test review pass. This refinement is implemented but not deployed.

Fullscreen submission refinement (2026-10-08): after Send captures and clears a fullscreen draft, an eligible existing-chat composer collapses directly to its disabled idle row while the authoritative submission state continues to own disabled controls and the sending indicator. Captured attachments may remain in submission state without forcing the expanded inline presentation. A failed submission restores its draft and therefore restores the active presentation through the normal content predicate; no timer or parallel lifecycle state is introduced. A rendered regression records every collapsed state during a held request and rejects any intermediate active row. All 74 focused composer tests and 28 bundled-Chromium idle/motion/fullscreen cases pass, along with production build/typecheck, frontend trim and all 11 responsive-ownership fixtures. Independent review found no blockers across successful acknowledgment, failure restoration, attachment-only input, focus state and cross-tab ownership.
