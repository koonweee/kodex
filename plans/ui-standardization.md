# UI Standardization Plan

## Scope

Standardize the Kodex web UI primitives and styling tokens so repeated controls share one visual contract across the composer, sidebar, preferences, approvals, timeline, and mobile shell. This is a UI consistency pass only; it should not change gateway APIs, generated OpenAPI types, app-server behavior, thread lifecycle behavior, or deployment assumptions.

The work should preserve the current product shape: a compact work-focused app shell, project/thread navigation on the side, timeline in the main pane, and composer anchored at the bottom.

## Status

Complete. Implementation, automated verification, agent-browser validation, follow-up selected-outline polish, and independent review-fix loops are complete.

## Implementation Notes

- Added shared UI token aliases and semantic tone tokens in `apps/web/src/themeRegistry.ts` and `apps/web/src/styles/ui.css`.
- Standardized repeated button, selectable, badge, focus, radius, shadow, menu, modal, composer, sidebar, preferences, timeline, image overlay, and approval-surface styling around shared tokens.
- Converted the account settings dropdown to the shared Mantine menu path while preserving Preferences, Logout, usage-limit display, and the debug-events checkbox behavior.
- Moved approval card/action CSS into `apps/web/src/styles/approvals.css`.
- Replaced unconfigured Mantine status colors in timeline/sidebar feedback with token-backed tone classes.
- Agent-browser responsive QA found the mobile permissions menu could overflow a `390px` viewport; fixed by capping composer menu width and allowing menu labels to wrap.
- Follow-up polish removed selected item borders and inner outlines while leaving selected backgrounds, keyboard focus rings, and semantic success/positive tones unchanged.
- Follow-up mobile polish keeps project and thread selector row height content-derived and increases their label font size to `16px` at mobile widths.

## Verification

- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.
- `cd apps/web && npm run test:e2e` passes.
- Follow-up focused checks pass: `cd apps/web && npm run build`, `cd apps/web && npm test -- ComposerFooterControls.test.tsx App.test.tsx`, token audit, and `git diff --check`.
- Mobile typography polish checks pass: `cd apps/web && npm run build` and `git diff --check`.
- Token audit passes: every `var(--kodex-*)` reference has a definition.
- Agent-browser pass completed against a Vite app with a local mock gateway, including desktop `1440x1000`, narrow `900x900`, and mobile `390x844` screenshots under `dogfood-output/ui-standardization/screenshots/`.
- Review-fix loop completed:
  - First review found account debug menu semantics, Fast row behavior, and running status tone issues; all were fixed.
  - Second review found checkbox menu semantics and keyboard activation issues; fixed with shared `CheckboxMenuItem`.
  - Final focused review found no major issues.
  - Follow-up review found no major issues in selected-outline token usage.

## Current Findings

- Color scheme tokens already live in `apps/web/src/themeRegistry.ts`, and Mantine receives only `accent`, `gray`, and `red` in `apps/web/src/theme.ts`.
- Several UI states use Mantine colors outside that token bridge, including `yellow`, `orange`, and `teal` status or badge colors.
- Global Mantine menu and modal styling exists in `apps/web/src/styles/base.css`, but the account settings menu is handcrafted with a separate menu surface and item style.
- Button-like controls are split across Mantine `Button`, Mantine `ActionIcon`, and raw `<button>` elements with local CSS in composer, sidebar, preferences, mobile tabs, image preview, and settings menu code.
- Selectable rows and options repeat the same selected/hover/focus concepts across sidebar thread rows, preferences section buttons, color-scheme options, and mobile tabs.
- Radius, shadow, overlay, and focus values are hard-coded across CSS files instead of going through shared tokens.
- `apps/web/src/styles/preferences.css` references `--kodex-bg-sidebar`, but the theme registry defines `--kodex-bg-sidebar-hover`, not `--kodex-bg-sidebar`.
- `.kodex-debug-toggle` and approval styles are spread across multiple CSS files.

## Principles

- Keep styling behavior-preserving unless a milestone explicitly calls out a visible difference.
- Prefer shared CSS tokens for visual consistency before adding React abstractions.
- Add shared React components only when they remove repeated semantics, accessibility rules, or behavior.
- Keep components in existing domain directories unless a primitive is reused across multiple domains.
- Use Mantine primitives where they already provide keyboard behavior, focus management, portal behavior, and ARIA structure.
- Use focused tests for behavior or accessibility changes. Pure visual token rewrites do not need new tests unless they protect a regression-prone behavior.
- Do not introduce handwritten gateway DTOs or API contract docs.

## Non-Goals

- No redesign of the shell, composer, timeline, or sidebar information architecture.
- No new theme picker behavior beyond preserving the existing color-scheme choices.
- No OpenAPI, backend, app-server, or persistence changes.
- No new component library package or external styling framework.
- No public deployment or auth changes.

## Milestone 1: Token Foundation

Status: Complete

Implementation:

- Add missing shared tokens for reusable visual primitives:
  - Surface backgrounds: app, shell, panel, raised, muted, hover, selected, selected-strong.
  - Semantic colors: success, warning, danger, info, accent, muted.
  - Focus ring, divider, menu shadow, modal shadow, overlay, and common radii.
- Fix the undefined `--kodex-bg-sidebar` reference by either adding the token to each color scheme or replacing the use with an existing surface token.
- Extend the Mantine theme bridge with all semantic color tuples the app uses, or replace direct Mantine color names with local token-backed classes.
- Keep existing scheme identities intact; this pass should not collapse the available color themes into one palette.

Exit criteria:

- No CSS references an undefined `--kodex-*` variable.
- Status, warning, approval, danger, and accent visuals can be themed without falling back to unconfigured Mantine defaults.
- Common radius, focus, shadow, divider, and overlay values are represented by shared tokens.
- `cd apps/web && npm test` passes if token behavior is covered by existing tests.
- `cd apps/web && npm run build` passes.

Expected UI differences:

- Warning, approval, and status badge colors may shift slightly so they follow the active Kodex color scheme.
- Focus rings and rounded corners may become more consistent across domains.

## Milestone 2: Menu Standardization

Status: Complete

Implementation:

- Create a shared menu styling path for Mantine `Menu.Dropdown`, `Menu.Item`, labels, dividers, active state, destructive state, and disabled state.
- Convert the account settings dropdown in `SidebarAccountFooter` from custom absolute-positioned markup to Mantine `Menu`, preserving preferences, logout, debug toggle, and usage limit display.
- Keep composer model, permissions, attachment, and thread action menus on the same menu surface contract.
- Remove duplicated `.kodex-debug-toggle` styling once the debug toggle is rendered through the shared menu item path or has a single retained custom class.

Exit criteria:

- Account settings, composer menus, attachment menu, and thread action menu share the same menu surface, item spacing, radius, hover, active, and shadow rules.
- Account settings keeps keyboard-accessible menu behavior and closes after Preferences and Logout actions.
- Existing account/sidebar tests are updated if role structure changes from custom buttons to Mantine menu items.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.

Expected UI differences:

- The account settings menu will likely become slightly larger and rounder, matching composer/thread menus.
- Debug toggle active and hover treatment should match other menu active states.

## Milestone 3: Button and Icon Action Standardization

Status: Complete

Implementation:

- Introduce a small shared primitive layer under `apps/web/src/ui` for common action styles, such as:
  - Text button defaults for compact secondary actions.
  - Icon action defaults for subtle, filled, danger, and selected states.
  - A raw-button reset class for semantic buttons that cannot use Mantine directly.
- Apply shared styles to composer controls, approval actions, sidebar project/thread actions, account login actions, preferences buttons, mobile tabs, and image/lightbox controls where appropriate.
- Keep specialized controls bespoke when their layout is unique: composer send/stop, sidebar resize handle, context usage ring, image thumbnail open target, and lightbox backdrop.

Exit criteria:

- Repeated button-like controls share hover, active, disabled, focus, text color, and icon color behavior.
- Raw `<button>` usage is either intentionally semantic and documented by class choice or replaced with Mantine `Button`/`ActionIcon`.
- Approval action tones still distinguish positive, neutral, and danger choices.
- Composer send/stop affordance remains visually primary and does not regress disabled behavior.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.

Expected UI differences:

- Secondary action padding and hover colors may normalize by a few pixels.
- Sidebar archive, show-more, mobile tab, and preference section buttons should look like variants of one system instead of separate one-off controls.

## Milestone 4: Selectable Rows, Tabs, and Options

Status: Complete

Implementation:

- Standardize selected, hover, focus, and disabled styling for:
  - Sidebar thread rows.
  - Sidebar project titles.
  - Preferences section buttons.
  - Color-scheme radio options.
  - Mobile panel tabs.
- Prefer shared CSS classes or data attributes over a single React component because these controls have different ARIA roles.
- Keep role-specific behavior intact: sidebar rows remain list-style navigation buttons, color schemes remain radiogroup/radio, and mobile panels remain tablist/tab.
- Ensure long text truncation and sidecar badges remain stable in sidebar rows.

Exit criteria:

- All selectable controls use the same selected background, hover background, disabled text tokens, and keyboard focus ring without a persistent selected border.
- Keyboard focus is visible for each selectable control.
- Color scheme radio keyboard behavior still supports arrows, Home, and End.
- Existing sidebar, preferences, and shell tests pass.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.

Expected UI differences:

- Mobile active tabs may use the selected token instead of the generic hover token.
- Color-scheme options and sidebar rows use consistent selected backgrounds and keyboard focus outlines without persistent selected borders.

## Milestone 5: Status, Badge, and Feedback Tones

Status: Complete

Implementation:

- Add a shared tone helper or constants for `neutral`, `accent`, `success`, `warning`, `danger`, and `info`.
- Route timeline status badges, warning/error text, thread approval badges, error badges, approval actions, unread indicators, progress indicators, and context unknown state through the semantic tone system.
- Avoid prompt-domain-specific labels or colors; status mapping should remain protocol/state based.
- Keep `color="red"` only where it maps through the configured Kodex red tuple or replace it with token-backed styling.

Exit criteria:

- Timeline status colors no longer rely on unconfigured Mantine `yellow`, `orange`, or `teal` defaults.
- Warning, approval-required, failed, cancelled, running, unread, and unknown-context states have distinct semantic treatments.
- Existing timeline renderer tests pass or are updated for any intentional label/state changes.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.

Expected UI differences:

- Approval badges and warning states may become less saturated or more theme-aligned.
- Normal completed statuses should remain quiet.

## Milestone 6: Surfaces, Cards, and Content Blocks

Status: Complete

Implementation:

- Standardize surface classes/tokens for cards, command panels, approval cards, empty panels, project form, queued steer card, composer, modal content, and code blocks.
- Consolidate approval card styles into one ownership location instead of splitting base card and approval-specific rules across timeline and preferences CSS files.
- Replace hard-coded shadows and overlays with tokens.
- Keep timeline content density intact; this milestone is not a timeline redesign.

Exit criteria:

- Repeated card-like surfaces use shared radius, border, background, padding, and shadow tokens.
- Approval card CSS lives in one clear owner file.
- Command output, approval command text, inline code, and timeline debug payloads remain bounded and readable.
- Empty state and project form styling still fit sidebar and main-panel contexts.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.

Expected UI differences:

- Cards and panels may share more consistent corner radius and border color.
- Approval cards may visually align more closely with queued steer and project form surfaces.

## Milestone 7: Responsive Polish and Regression Pass

Status: Complete

Implementation:

- Review the standardized controls at desktop, tablet, and mobile widths.
- Check that composer footer controls wrap without text overlap.
- Check that menus fit available space and do not clip important controls.
- Check that sidebar thread rows still preserve hover archive affordances, unread indicators, and approval badges.
- Remove obsolete CSS selectors after the shared primitive styles are in place.

Exit criteria:

- No visible text overlaps or clipped button labels at common desktop and mobile widths.
- No unrelated CSS selectors or duplicate old primitive styles remain.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.
- `cd apps/web && npm run test:e2e` passes if Playwright coverage is affected by the UI structure.
- A manual agent-browser pass is completed using the instructions below.

Expected UI differences:

- Layout should feel more internally consistent, but the application should still look recognizably like the current Kodex web UI.

## Agent Browser Pass

Run this pass after all implementation milestones are complete, tests pass, and a local full-stack or mocked frontend environment is available.

### Setup Instructions

- Use the `agent-browser` skill and load the installed CLI workflow before starting:
  - `agent-browser skills get core`
  - `agent-browser skills get dogfood`
- Start the app using the repo workflow appropriate to the change:
  - Prefer the full-stack dev workflow when validating real account/project/thread behavior.
  - Use the existing frontend dev server plus mocks only when the implementation agent has deliberately scoped validation to frontend-only behavior.
- Test at these viewport sizes:
  - Desktop: `1440x1000`.
  - Narrow desktop/tablet: `900x900`.
  - Mobile: `390x844`.
- Capture screenshots or notes for every failure, including viewport size, active color scheme, and the control being tested.

### Required Test Cases

- **Theme switching**
  - Open Preferences.
  - Switch through every color scheme.
  - Verify menu, modal, selected option, focus ring, badge, composer, sidebar, and timeline colors all follow the active scheme.
  - Verify no panel uses a browser/default fallback color that clashes with the selected theme.

- **Composer controls**
  - Open the attachment menu.
  - Open the permissions menu and inspect default, auto review, and full access states.
  - Open the model/speed menu and inspect active model, reasoning options, and Fast toggle.
  - Verify hover, selected, disabled, and active states are consistent across these menus.
  - Verify the send button, stop button, attachment action, context indicator, and settings error icon keep stable size and spacing.

- **Sidebar and account controls**
  - Create/open the project form and inspect inputs plus submit button.
  - Hover and focus project and thread rows.
  - Verify unread indicator, in-progress spinner, approval badge, archive action, show-more button, and selected thread row remain legible.
  - Open account settings and verify it matches other app menus.
  - Toggle debug events and verify the checked state is visually clear.

- **Preferences and mobile tabs**
  - Open Preferences and keyboard through color scheme radio options with Arrow keys, Home, and End.
  - Verify focus remains visible and selected state is not dependent on color alone.
  - At mobile width, switch between Threads and Chat tabs and verify active state, spacing, and shell layout.

- **Timeline, approvals, and feedback**
  - Inspect a thread with normal assistant/user messages, tool activity, warnings/errors if available, and debug mode.
  - Verify status badges use semantic tones consistently.
  - Inspect approval cards and approval action buttons for positive, neutral, and danger styling.
  - Expand and collapse timeline details, command output, and debug payloads; verify caret, hover, and focus behavior.

- **Images and overlays**
  - Attach an image in the composer if available.
  - Open a timeline or composer image preview.
  - Verify thumbnail, remove button, lightbox backdrop, and close behavior remain usable across themes.

- **Responsive stress**
  - At `390x844`, verify no toolbar label, badge, menu item, or modal text overlaps.
  - At `900x900`, verify the mobile switcher boundary and sidebar/main layout do not create duplicate scroll traps.
  - At `1440x1000`, verify the main column, composer, timeline scroll-to-bottom button, and floating menus align cleanly.

### Agent Browser Exit Criteria

- All required test cases pass in at least one dark scheme and one light scheme.
- Any intentional visual differences from this plan are documented in the implementation summary.
- No severe layout bug remains: no overlapping controls, unreadable text, unreachable menu item, invisible focus state, or broken mobile navigation.
- Screenshots or concise notes are attached to the implementation handoff for every failed case that was fixed or intentionally deferred.
