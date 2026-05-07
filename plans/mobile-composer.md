# Mobile Composer Plan

## Status

Proposed. This plan adapts the composer for mobile by keeping shared composer logic while giving phone layouts their own compact dock, focused bottom sheet, expanded compose sheet, and mobile-specific skill command sheet.

## Design References

Generated low-fidelity skeleton mockups:

- [Mobile composer mockups](assets/mobile-composer-mockups.png)

Use the mockups as interaction and density references, not exact visual specs. The three target states are:

- `Compact`: small idle dock above the mobile safe area.
- `Focused`: elevated bottom sheet above the keyboard with compact suggestions.
- `Expanded`: near-fullscreen compose sheet for long prompts, attachments, skills, and settings.

## Problem

The current `ComposerPanel` is desktop-shaped and then compressed on mobile. On phones, the browser chrome plus keyboard consumes much of the viewport. The current composer also carries dense controls in one surface:

- multiline prompt input
- pending attachments
- plus menu
- permissions/model/effort controls
- context usage
- branch/project underbar
- skill autocomplete
- send/stop

Even after the skill autocomplete became an absolute popover, mobile still has a different layout problem: too many composer-adjacent surfaces compete with the keyboard and timeline. Shrinking the desktop composer is not enough.

## Goals

- Keep one shared composer behavior model for draft text, skill bindings, attachments, settings, submit/stop, and API payload construction.
- Add mobile-specific presentation components that do not inherit desktop density.
- Preserve desktop behavior and tests unless a desktop bug is intentionally fixed.
- Make quick one-line sends cheap from a compact dock.
- Promote richer drafting to a focused bottom sheet or expanded compose sheet.
- Render skill suggestions as a mobile command sheet/list inside the mobile composer, not as a desktop-style floating popover.
- Avoid browser-local ownership for state that must converge across tabs. Mobile sheet mode, focus, tabs, and scroll are per-tab UI state only.

## Non-Goals

- No gateway API changes.
- No new durable draft persistence across reloads.
- No desktop composer redesign beyond extraction needed for shared logic.
- No rich text editor, prompt template library, or slash-command framework.
- No native app keyboard APIs. The web client should use browser viewport signals and CSS dynamic viewport units.

## Current Code Grounding

Current ownership:

- `apps/web/src/composer/ComposerPanel.tsx`
  - Owns `composerText`, `skillBindings`, `skillToken`, `activeSkillIndex`, textarea keyboard handling, desktop render, desktop skill popup placement, toolbar, underbar, and submit payload helpers.
- `apps/web/src/composer/useComposerOrchestration.ts`
  - Owns pending attachments, submit/stop/queued steer orchestration, image uploads, optimistic user messages, drag/drop, paste, and attachment object URL lifecycle.
- `apps/web/src/composer/useSkillCatalog.ts`
  - Owns skill catalog loading, refresh, invalidation, and error state.
- `apps/web/src/ComposerFooterControls.tsx`
  - Owns the current desktop model, effort, fast mode, permissions, and context controls.
- `apps/web/src/composer/SkillMentionPopup.tsx`
  - Desktop-oriented listbox UI for `$` suggestions.
- `apps/web/src/styles/composer.css`
  - Desktop composer surface, toolbar, underbar, skill popup, queued steer, and current mobile menu overrides.
- `apps/web/src/shell/KodexShellView.tsx`
  - Renders `ThreadPanel` and `ComposerPanel` in the mobile/desktop shell.
- `apps/web/src/styles/preferences.css`
  - Contains the existing `900px` mobile shell breakpoint and mobile main/sidebar display rules.

The implementation should first pull behavior out of `ComposerPanel.tsx`, then render separate desktop and mobile representations from that shared behavior.

## Target Architecture

Add a shared composer controller layer:

- `apps/web/src/composer/useComposerDraftState.ts`
  - `composerText`
  - `skillBindings`
  - `skillToken`
  - `activeSkillIndex`
  - `updateComposerText`
  - skill select/delete behavior
  - submitted skill input/text element/timeline mention helpers
  - reset/restore controls
- `apps/web/src/composer/useComposerKeyboardViewport.ts`
  - Tracks `window.visualViewport` where available.
  - Exposes keyboard-aware values for mobile sheet sizing.
  - Falls back to `100dvh` and safe-area padding when visual viewport is unavailable.
- `apps/web/src/composer/ComposerPanel.tsx`
  - Becomes the stateful controller shell that chooses desktop or mobile presentation.
  - Keeps draft state mounted while switching representations so text is not lost on rotate or resize.
- `apps/web/src/composer/DesktopComposerPanel.tsx`
  - Current desktop layout, moved out of `ComposerPanel.tsx`.
  - Keeps `SkillMentionPopup`.
- `apps/web/src/composer/MobileComposerPanel.tsx`
  - Mobile layout coordinator.
  - Owns only UI mode: `compact`, `focused`, `expanded`; active mobile tab; sheet scroll/focus.
- `apps/web/src/composer/MobileSkillCommandSheet.tsx`
  - Compact mobile skill suggestions using shared filtered skills and selection handlers.
- `apps/web/src/composer/MobileComposerSettingsSheet.tsx`
  - Mobile settings representation for model/effort/fast/permissions/context if the focused or expanded sheet needs a details surface.

Shared logic must remain source-compatible with existing `onSubmitTurn`, `onStopTurn`, attachment, settings, and queued steer props from `App.tsx`.

## Mobile UX Shape

Compact state:

- Render only when the mobile composer is not focused and no dense interaction is active.
- Show a small dock at the bottom of the thread pane:
  - one-line placeholder or first draft line
  - attachment/plus icon
  - concise permissions chip
  - concise model chip
  - send/stop icon
- Hide context usage, branch/project underbar, and full settings labels by default.
- Tapping the input area enters `focused`.
- Tapping an explicit expand affordance enters `expanded`.

Focused state:

- Use an elevated bottom sheet above the keyboard.
- Keep the thread visible behind it, with no layout push.
- Textarea gets more vertical room than the compact dock.
- Primary send/stop stays pinned in the sheet footer.
- Attachment/settings/model controls collapse to icons or short chips.
- Pending attachments render in a horizontal preview row.
- If `$` autocomplete is active, show a compact command list inside the sheet:
  - name and `$skill` first
  - one-line description only if it fits
  - selected row state for keyboard navigation when hardware keyboard is present
- The sheet max height should be based on available visual viewport, with a fallback similar to `max-height: min(70dvh, calc(100dvh - safe-area - header-space))`.

Expanded state:

- Use a near-fullscreen sheet or fullscreen modal with a top bar:
  - close/back action
  - title `Compose`
  - optional collapse action
- Large textarea is the primary content.
- Footer send/stop remains pinned above the safe area.
- Attachments, Skills, Context, and Settings become internal sections/tabs instead of competing popovers.
- Skill selector appears as an internal command sheet/list under the `Skills` section or automatically when `$` is active.
- The timeline behind the composer should not scroll while expanded.

## Responsive Rules

- Use the existing `900px` app shell breakpoint for choosing mobile composer representation.
- Use a narrower secondary breakpoint only for intra-composer density tweaks if needed.
- Every editable control in the mobile composer must have an effective font size of at least `16px` to avoid iOS Safari input zoom.
- Mobile tap targets for composer actions, sheet controls, skill rows, attachment remove buttons, and settings rows should be at least `44px`.
- Use `100dvh`, `env(safe-area-inset-bottom)`, and visual viewport measurements to prevent footer actions from landing under browser chrome or the keyboard.
- Avoid nested scroll traps:
  - thread scroll belongs to the timeline when the composer is compact
  - sheet body scroll belongs to the focused/expanded composer when active
  - keyboard-open skill suggestions scroll inside their own list with a bounded height

## Milestone 1: Extract Shared Composer Draft Logic

Failing tests first:

- Existing `ComposerPanel` skill autocomplete tests should pass through the extracted hook without behavior changes.
- A new focused test verifies draft text, selected skill bindings, and pending text survive switching between desktop and mobile presentation.
- A new helper test verifies submitted `skillInputs`, `skillTextElements`, and `skillMentions` are identical before and after extraction.

Implementation:

- Move text, skill binding, active token, active index, select/delete, reset/restore, and submitted binding helpers from `ComposerPanel.tsx` into `useComposerDraftState.ts`.
- Keep `useSkillCatalog.ts` unchanged except for any type polish needed by the new hook.
- Keep current desktop JSX visually unchanged by rendering it through `DesktopComposerPanel.tsx`.
- Keep current CSS classes for desktop to reduce regression risk.

Exit conditions:

- `npm test -- ComposerPanel.test.tsx` passes.
- Desktop skill autocomplete and submit behavior remain unchanged.
- `ComposerPanel.tsx` is smaller and acts as a controller, not the only renderer.

## Milestone 2: Add Mobile Compact Dock

Failing tests first:

- At a mocked mobile viewport, the compact mobile composer renders instead of the desktop footer-heavy composer.
- Compact state hides full context usage and branch/project underbar.
- Compact send calls the same `onSubmitTurn` path as desktop for text, attachments, and skills.
- Switching from compact to focused does not clear draft text.

Implementation:

- Add responsive presentation choice in `ComposerPanel.tsx`.
- Add `MobileComposerPanel.tsx` with `compact` mode.
- Add mobile-specific CSS in `apps/web/src/styles/composer.css` or a new imported `styles/mobile-composer.css` if the composer stylesheet becomes too large.
- Keep the desktop `ComposerFooterControls` mounted only in desktop representation; mobile uses summary chips and opens settings details on demand.
- Preserve existing attachment input ref and add button behavior.

Exit conditions:

- Compact dock matches the `Compact` mockup shape.
- No desktop CSS regression.
- Mobile composer has no overflowing labels at 390px width.

## Milestone 3: Focused Keyboard-Aware Bottom Sheet

Failing tests first:

- Focusing the mobile composer enters focused mode.
- Escape/cancel/collapse exits focused mode without losing draft text.
- Visual viewport changes update sheet sizing through `useComposerKeyboardViewport`.
- Send button remains reachable when viewport height shrinks.

Implementation:

- Add focused bottom-sheet state to `MobileComposerPanel.tsx`.
- Add `useComposerKeyboardViewport.ts`.
- Use fixed or sticky positioning inside the mobile shell so the sheet overlays the timeline instead of pushing it.
- Lock or stabilize background timeline scrolling while the focused sheet is actively being dragged/scrolled if necessary.
- Keep the textarea autosize bounded to the sheet body.

Exit conditions:

- Focused sheet matches the `Focused` mockup shape.
- Keyboard-open layout avoids hidden send controls and avoids forcing the user through long page scrolls.
- Manual or browser-automation screenshots cover 390px wide mobile viewport with focused textarea.

## Milestone 4: Mobile Skill Command Sheet

Failing tests first:

- Typing `$` in mobile focused mode opens `MobileSkillCommandSheet`, not `SkillMentionPopup`.
- Skill filtering and keyboard selection reuse the same shared logic as desktop.
- Selecting a skill writes the same replacement text and binding as desktop.
- Long skill names/descriptions truncate without overlapping action controls.

Implementation:

- Add `MobileSkillCommandSheet.tsx`.
- Reuse `filterSkillsForQuery`, `replaceSkillMentionToken`, and `useSkillCatalog`.
- Render compact rows:
  - display name
  - `$name`
  - optional scope badge
  - optional one-line short description
- Keep loading, error, and empty states short.
- On mobile, close the command sheet on outside sheet collapse, Escape, successful selection, or text cursor leaving the active token.

Exit conditions:

- Skill command sheet matches the `Focused` and `Expanded` mockup intent.
- It never increases the height of the outer composer shell in a way that pushes timeline content.
- Existing desktop `SkillMentionPopup` tests still pass.

## Milestone 5: Expanded Compose Sheet

Failing tests first:

- Tapping expand opens the expanded mobile compose sheet.
- Expanded sheet keeps draft text, attachments, skill bindings, and settings state from compact/focused mode.
- Closing expanded returns to focused or compact according to prior state without clearing the draft.
- Send from expanded submits through the same path and closes/clears on successful submit.

Implementation:

- Add expanded mode to `MobileComposerPanel.tsx`.
- Add top bar with `Compose`, close, and collapse controls.
- Add internal sections/tabs for:
  - prompt
  - attachments
  - skills
  - context
  - settings
- Reuse existing attachment tray logic, but render it as a horizontally scrollable mobile row.
- Render model/effort/fast/permissions through `MobileComposerSettingsSheet.tsx` or an internal settings section that calls the existing `onComposerSettingsChange`.

Exit conditions:

- Expanded state matches the `Expanded` mockup shape.
- Long prompts are readable and editable without thread/page scroll conflicts.
- Send/stop remains pinned and reachable above safe area.

## Milestone 6: Responsive QA And Cleanup

Failing tests first:

- Add component/integration coverage for mobile mode transitions:
  - compact to focused
  - focused to expanded
  - `$` command sheet open/select
  - attachment preview in focused/expanded
  - settings change in mobile representation
- Add CSS regression checks where useful for fixed/sheet positioning and 16px mobile input sizes.

Implementation:

- Run focused and broad frontend checks:
  - `npm test -- ComposerPanel.test.tsx`
  - relevant app-level mobile shell tests
  - `npm run build`
- Use browser automation screenshots for:
  - desktop composer unchanged
  - mobile compact state
  - mobile focused state
  - mobile expanded state
  - mobile skill command sheet
- Fix text overlap, clipped controls, nested scroll traps, and safe-area issues found in screenshots.

Exit conditions:

- Desktop and mobile screenshots match the intended mockup structure.
- Mobile manual QA confirms the keyboard does not hide primary composer actions.
- No gateway/OpenAPI changes are required.
- `plans/index.md` is updated when implementation status changes.

## Test Strategy

Unit and component tests:

- `apps/web/src/composer/useComposerDraftState.test.ts`
- `apps/web/src/composer/useComposerKeyboardViewport.test.ts`
- `apps/web/src/composer/ComposerPanel.test.tsx`
- `apps/web/src/composer/MobileComposerPanel.test.tsx`
- `apps/web/src/composer/MobileSkillCommandSheet.test.tsx`

App-level tests:

- Add mobile-shell coverage to the closest existing app test when behavior crosses shell boundaries.
- Avoid growing broad MVP tests unless the behavior genuinely spans shell routing, selected thread state, and composer submission.

Browser QA:

- Use a mobile viewport around `390x844`.
- Verify at least:
  - compact idle composer
  - focused composer with a long draft
  - focused composer with skill command sheet open
  - expanded compose sheet
  - desktop composer unchanged

Two-tab correctness:

- Mobile mode, focused state, expanded state, selected tab, and sheet scroll are intentionally per-tab.
- Submitted turns, queued steers, pending commit rows, settings persistence, and thread state remain gateway/app-server-owned through existing paths.
- No new shared lifecycle decision should be derived only from mobile React state.

## File Plan

- `apps/web/src/composer/ComposerPanel.tsx`
- `apps/web/src/composer/DesktopComposerPanel.tsx`
- `apps/web/src/composer/MobileComposerPanel.tsx`
- `apps/web/src/composer/MobileSkillCommandSheet.tsx`
- `apps/web/src/composer/MobileComposerSettingsSheet.tsx`
- `apps/web/src/composer/useComposerDraftState.ts`
- `apps/web/src/composer/useComposerKeyboardViewport.ts`
- `apps/web/src/composer/SkillMentionPopup.tsx`
- `apps/web/src/composer/useSkillCatalog.ts`
- `apps/web/src/composer/skillMentions.ts`
- `apps/web/src/composer/AttachmentTray.tsx`
- `apps/web/src/composer/QueuedSteerCard.tsx`
- `apps/web/src/ComposerFooterControls.tsx`
- `apps/web/src/styles/composer.css`
- Optional if CSS grows too large: `apps/web/src/styles/mobile-composer.css`
- `apps/web/src/App.css`
- Focused tests under `apps/web/src/composer`
- App-level mobile shell tests only where needed

## Open Decisions

- Whether focused mode should open automatically on textarea focus for every phone width, or only after the user types more than one line. Recommended first pass: open on focus below the existing mobile shell breakpoint.
- Whether expanded mode should be automatic when skill suggestions are open and available height is below a threshold. Recommended first pass: explicit expand affordance plus automatic expansion only for very long drafts.
- Whether mobile settings should be a dedicated sheet or tabs inside expanded mode. Recommended first pass: simple sheet from focused mode, full settings section in expanded mode if needed.
- Whether hardware keyboard arrow navigation matters on mobile. Recommended first pass: keep existing keyboard behavior because it falls out of shared logic, but optimize touch rows first.
