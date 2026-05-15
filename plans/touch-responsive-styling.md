# Touch And Narrow Viewport Styling Plan

## Status

Complete. Implemented shared input capability helpers, moved touch/coarse-pointer decisions out of feature-local `matchMedia` checks, split touch ergonomics from width-only layout in composer/sidebar/automations/Mantine styles, and updated contributor guidance in `AGENTS.md`.

Verification completed:

- `cd apps/web && npm test -- inputCapabilities`
- `cd apps/web && npm test -- ComposerPanel.test.tsx MobileComposerPanel.test.tsx App.mvp.composer-input.test.tsx App.mvp.composer-settings.test.tsx`
- `cd apps/web && npm test -- WorkspaceSidebar WorkspaceSidebar.reorder.test.tsx`
- `cd apps/web && npm test -- App.automations.test.tsx`
- `cd apps/web && npm run build`
- `rg -n "maxTouchPoints|any-pointer: coarse|pointer: coarse|hover: none" apps/web/src`
- `git diff --check`
- `$agent-browser` smoke checked desktop fine-pointer and narrow fine-pointer states against the local Vite app. The installed Chrome/device emulation did not expose coarse-pointer or `navigator.maxTouchPoints`; mobile touch behavior remains covered by focused unit/component tests.

## Context

- The web app currently mixes `(max-width: ...)` rules with touch-device behavior in the composer, sidebar, automations UI, and shared Mantine styling.
- The audit found several rules that should apply only to touch or coarse-pointer devices, while true space-constrained layout rules should remain viewport-based.
- The implementation should standardize capability detection so new code does not add ad hoc `matchMedia("(any-pointer: coarse)")`, `matchMedia("(pointer: coarse)")`, or `navigator.maxTouchPoints` checks in feature components.

Relevant code seams:

- `apps/web/src/composer/inputCapabilities.ts` already exposes `isTouchInputDevice()` but is composer-owned.
- `apps/web/src/composer/ComposerPanel.tsx` chooses `MobileComposerPanel` from only `(max-width: 900px)`.
- `apps/web/src/composer/MobileComposerPanel.tsx` has local touch detection for fullscreen expansion and keyboard-aware mobile UI.
- `apps/web/src/styles/mobile-composer.css` contains mobile composer density, safe-area, visual viewport, and touch scrolling rules.
- `apps/web/src/threads/WorkspaceSidebar.tsx` computes `useTouchDensity = isMobileSidebar || hasCoarsePointer`.
- `apps/web/src/styles/sidebar.css` mixes narrow sidebar layout with 44px action rows, 16px search input, always-visible actions, and no-hover affordances.
- `apps/web/src/automations/AutomationEditorModal.tsx`, `apps/web/src/automations/PromptMarkdownEditor.tsx`, and `apps/web/src/styles/automations.css` use viewport width for both compact layout and touch modal ergonomics.
- `apps/web/src/styles/mantine-components.css` sets 16px input font size for all viewports under `767px`.
- `AGENTS.md` should document the distinction so the pattern is preserved after this pass.

## Current State

- Narrow shell structure is width-owned through `(max-width: 900px)` and URL/mobile-panel state in `App.tsx`, `KodexShellView.tsx`, `preferences.css`, and `shell.css`.
- Touch detection exists but is not shared outside composer ownership.
- Some tests already encode the current mixed behavior:
  - `apps/web/src/threads/WorkspaceSidebar.reorder.test.tsx` expects touch density at narrow width.
  - `apps/web/src/composer/MobileComposerPanel.test.tsx` covers touch and non-touch narrow composer behavior.
  - `apps/web/src/App.mvp.composer-input.test.tsx` checks Enter handling on narrow non-touch and touch inputs.
- Existing hover cleanup in `sidebar.css` correctly uses `@media (hover: none), (pointer: coarse)` and should be preserved.
- The plan should not change gateway APIs, generated OpenAPI artifacts, app-server behavior, or shared thread/session state.

## Principles

- Use viewport width for structural layout and content fit: one-panel shell, table-to-card transforms, stacked forms, hidden side panes, and no-overflow image grids.
- Use touch/coarse-pointer capability for interaction ergonomics: 44px targets, 16px editable inputs for iOS zoom avoidance, safe-area and visual-viewport keyboard behavior, bottom sheets, touch scrolling, and controls that must be visible without hover.
- Use fine-hover capability for hover-only affordances. Touch users must have a non-hover path to every action.
- Keep browser-local responsive state limited to visual/per-tab concerns. Do not move gateway-owned lifecycle or thread state into responsive hooks.

## Milestones

### 1. Shared Responsive Capability Helpers

- Scope: shared frontend helper and tests.
- Work:
  - Move `isTouchInputDevice()` out of `apps/web/src/composer/inputCapabilities.ts` into a shared module, such as `apps/web/src/shared/inputCapabilities.ts`.
  - Add a focused hook, such as `useInputCapabilities()`, that reports touch/coarse/fine-hover capability and subscribes to relevant media query changes.
  - Keep width checks separate, either through Mantine `useMediaQuery` at call sites or a tiny shared `useViewportQuery()` wrapper if repeated test setup becomes clearer.
  - Replace direct `navigator.maxTouchPoints` and coarse-pointer checks in composer/sidebar code with the shared helper or hook.
- Exit criteria:
  - Focused helper tests cover maxTouchPoints, coarse pointer, fine hover, media query updates, and SSR-safe fallbacks.
  - `cd apps/web && npm test -- inputCapabilities` or the closest focused test command passes.
  - No feature component directly calls `window.matchMedia("(any-pointer: coarse)")`, `window.matchMedia("(pointer: coarse)")`, or `navigator.maxTouchPoints`.

### 2. Composer Touch Versus Narrow Width Split

- Scope: composer responsive selection, mobile composer CSS, run-settings and permissions menus.
- Work:
  - Update `useIsMobileComposer()` in `apps/web/src/composer/ComposerPanel.tsx` so keyboard-aware/fullscreen mobile composition is touch-gated instead of width-only.
  - Preserve narrow viewport layout constraints for the shell and inline composer without applying touch-only keyboard/fullscreen behavior to narrow non-touch windows.
  - Keep `MobileComposerPanel.tsx` using shared touch capability for fullscreen-on-focus and visual viewport behavior.
  - Split `apps/web/src/styles/composer.css` so menu bottom-sheet positioning, large permission rows, and chip-style mobile menu chrome require both narrow width and touch/coarse pointer.
  - Leave truly narrow layout constraints, such as overflow bounds and text wrapping needed to fit the viewport, width-based.
- Exit criteria:
  - Update composer tests to cover three cases: desktop fine pointer, narrow fine pointer, and narrow touch.
  - Narrow fine-pointer composer still supports Enter-to-submit and does not open fullscreen touch composer on focus.
  - Narrow touch composer still keeps Enter as newline unless Cmd+Enter is used, and fullscreen expansion remains keyboard-aware.
  - `cd apps/web && npm test -- ComposerPanel.test.tsx MobileComposerPanel.test.tsx App.mvp.composer-input.test.tsx` passes.

### 3. Sidebar Density And Hover Affordances

- Scope: sidebar capability usage and sidebar CSS split.
- Work:
  - Change `WorkspaceSidebar.tsx` so `data-density="touch"` is driven by shared touch/coarse capability, not narrow width alone.
  - Keep `isMobileSidebar` width-based for the single-panel sidebar scope selector and Projects/Chats filtering.
  - Split `apps/web/src/styles/sidebar.css` rules:
    - Keep mobile header/filter layout and content hiding width-based.
    - Move 44px action sizes, 16px search input sizing, and always-visible touch controls into touch/coarse scoped rules.
    - Preserve fine-hover rules for hover-revealed actions and the existing no-hover cleanup for touch.
  - Update sidebar tests that currently expect touch density from narrow width alone.
- Exit criteria:
  - Focused sidebar tests cover narrow fine pointer, wide coarse pointer, and narrow coarse pointer.
  - Thread pin/archive/disclosure actions remain reachable without hover on touch.
  - Narrow fine-pointer sidebar keeps compact density where space allows and does not lose keyboard/focus affordances.
  - `cd apps/web && npm test -- WorkspaceSidebar` passes.

### 4. Automations, Shared Mantine Inputs, And Modal Ergonomics

- Scope: automations UI, shared Mantine input CSS, and compact prompt editor behavior.
- Work:
  - Split `apps/web/src/styles/automations.css`:
    - Keep table-to-card layout and single-column form layout width-based.
    - Move 44px buttons, 16px editable inputs, full-height touch modal adjustments, safe-area footer padding, and keyboard-oriented prompt sizing behind touch/coarse scoped selectors.
  - Review `AutomationEditorModal.tsx` so `fullScreen` and tabbed mobile modal behavior are width-based only when needed for fit, and touch-specific safe-area/keyboard styling remains touch-gated.
  - Decide whether `PromptMarkdownEditor.tsx` compact tabs are width-only or should also consider touch; keep split preview/write width-based if the side-by-side editor cannot fit.
  - Change the global 16px input font rule in `mantine-components.css` to touch/coarse scoped, with any necessary narrow-width exceptions called out explicitly.
- Exit criteria:
  - Focused automations tests cover compact layout without assuming touch ergonomics on every narrow viewport.
  - `cd apps/web && npm test -- App.automations.test.tsx` passes.
  - `cd apps/web && npm run build` passes.

### 5. Contributor Guidance And Responsive Audit Guardrail

- Scope: `AGENTS.md`, style review guidance, and lightweight audit checks.
- Work:
  - Add frontend guidance to `AGENTS.md` that viewport width and input modality must be treated as separate concerns.
  - Document examples of width-only rules and touch-only rules.
  - Add a lightweight code review checklist or focused test assertions for future responsive changes. Prefer tests over brittle CSS string audits unless the CSS rule is regression-prone.
  - Run a final search for direct touch capability checks and small-viewport touch ergonomics that bypass the shared helper.
- Exit criteria:
  - `AGENTS.md` contains the responsive styling guidance.
  - `rg -n "maxTouchPoints|any-pointer: coarse|pointer: coarse" apps/web/src` shows only the shared helper, CSS media queries, tests, and intentional fine-hover/touch CSS blocks.
  - `git diff --check` passes.

## Verification

- Focused unit/component tests:
  - `cd apps/web && npm test -- ComposerPanel.test.tsx MobileComposerPanel.test.tsx App.mvp.composer-input.test.tsx`
  - `cd apps/web && npm test -- WorkspaceSidebar WorkspaceSidebar.reorder.test.tsx`
  - `cd apps/web && npm test -- App.automations.test.tsx`
  - Shared helper test for the new input capability module.
- Build:
  - `cd apps/web && npm run build`
- Static checks:
  - `rg -n "maxTouchPoints|any-pointer: coarse|pointer: coarse|hover: none" apps/web/src`
  - `git diff --check`
- Browser validation with `$agent-browser`:
  - Desktop fine pointer at `1440x1000`: compact sidebar rows, anchored composer menus, no touch fullscreen composer.
  - Narrow fine pointer at approximately `700x900`: width-based shell/layout changes still fit, but touch-only 44px density, iOS font sizing, and keyboard sheets are absent.
  - Touch/mobile viewport at `390x844`: mobile composer fullscreen, safe-area footer behavior, visible no-hover controls, and touch target sizing remain intact.

## Risks And Open Questions

- Some narrow non-touch layouts may still need larger targets for accessibility or readability. Resolve case by case in the owning CSS file rather than treating all narrow viewports as touch.
- Mantine portal positioning may need explicit width-based overflow handling even after bottom-sheet behavior is touch-gated. Verify composer settings and permissions menus in narrow fine-pointer browser validation.
- The shell's `mobilePanel` URL/navigation model is currently width-based in `App.tsx`; this plan does not change that unless browser validation proves narrow fine-pointer workflows need a separate desktop-style shell.
- CSS media queries can detect coarse pointers but not `navigator.maxTouchPoints`; React code should use the shared helper for JS decisions, while CSS should use `@media (pointer: coarse)` or `@media (any-pointer: coarse)` only for styling.
