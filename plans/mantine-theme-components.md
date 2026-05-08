# Mantine Theme Components Plan

## Scope

Make ordinary Mantine controls render with Kodex chrome by default, so new frontend features do not need to remember ad hoc classes for text boxes, dropdowns, menus, modals, badges, or action buttons.

This is a frontend styling-system change only. It does not change gateway APIs, OpenAPI output, app-server behavior, or shared thread state ownership.

## Problem

The current app has strong color-scheme tokens but weak component defaults.

The good foundation:

- `apps/web/src/main.tsx` imports `@mantine/core/styles.css` before app CSS.
- `apps/web/src/App.tsx` wraps the app in one `MantineProvider`.
- `apps/web/src/theme.ts` builds a Mantine theme from the active Kodex color scheme with custom `accent`, `gray`, and `red` tuples.
- `apps/web/src/themeRegistry.ts` owns the named Kodex color schemes and generated root CSS variables.
- `apps/web/vite.config.ts` injects a theme bootstrap script and `#kodex-theme-registry` style block before React mounts.
- `apps/web/src/styles/ui.css` defines reusable semantic tokens such as `--kodex-bg-panel`, `--kodex-border-subtle`, `--kodex-bg-selected`, and `--kodex-focus-outline`.

The inconsistent parts:

- `createKodexMantineTheme` does not set `theme.components`, so Mantine `TextInput`, `Textarea`, `Select`, `Menu`, `Modal`, `Drawer`, `Tabs`, and `SegmentedControl` fall back to Mantine defaults unless feature CSS catches them.
- `apps/web/src/styles/base.css` globally targets Mantine internals like `.mantine-Menu-dropdown`, `.mantine-Menu-label`, `.mantine-Modal-content`, and `.mantine-Modal-header`.
- Feature CSS also targets Mantine internals, for example:
  - `apps/web/src/styles/composer.css` targets `.mantine-Button-label`, `.mantine-Menu-itemLabel`, `.mantine-Menu-itemSection`, and menu item states.
  - `apps/web/src/styles/automations.css` targets `.mantine-Modal-content`, `.mantine-Modal-body`, `.mantine-Tabs-list`, `.mantine-Tabs-tab`, and `.mantine-Textarea-*`.
  - `apps/web/src/styles/timeline.css` targets `.mantine-Drawer-content`.
  - `apps/web/src/styles/approvals.css` targets `.mantine-Button-section`, `.mantine-Button-inner`, and `.mantine-Button-label`.
- Inputs are styled feature-by-feature:
  - Sidebar search uses `.kodex-sidebar-search input`.
  - Automation editor inputs use `className="kodex-automation-mobile-input"`.
  - Composer textareas use composer-specific classes.

The result is that adding a new Mantine form control can look unstyled unless the implementer knows which local class or selector to use.

## Target Behavior

New feature code should be able to use plain Mantine controls and get Kodex styling:

```tsx
<TextInput label="Name" />
<Select label="Target thread" data={options} />
<Textarea label="Prompt" />
<Menu.Item>Archive</Menu.Item>
<Modal opened={opened} onClose={onClose} title="Settings" />
```

Feature-specific CSS should be needed for layout, density, and one-off behavior, not for baseline chrome.

## Design Principles

- Keep `--kodex-*` semantic tokens as the source for Kodex-specific visual decisions.
- Use Mantine theme tokens for Mantine-native color behavior where they work well: `primaryColor`, `colors`, `fontFamily`, `radius`, sizes, and color scheme.
- Use `theme.components` for default props and default `classNames` on Mantine components.
- Avoid broad `.mantine-*` selectors for app policy. Prefer class names attached through `theme.components`.
- Keep feature layout local. Mobile full-screen modal sizing, composer menu chip layout, and sidebar row grids should remain in feature CSS.
- Do not introduce Storybook in the first pass. Build a lightweight app-native theme harness first.

## New Files

Add:

- `apps/web/src/theme/components.ts`
  - Exports `createKodexMantineComponents(): MantineThemeOverride["components"]`.
  - Imports Mantine components needed for `.extend(...)`, for example `TextInput`, `Textarea`, `Select`, `NumberInput`, `Button`, `ActionIcon`, `Menu`, `Modal`, `Drawer`, `Badge`, `Tabs`, `SegmentedControl`, and `Alert`.
- `apps/web/src/styles/mantine-components.css`
  - Contains only default Mantine component classes attached by `theme.components`.
  - Imported by `apps/web/src/App.css` after `ui.css` and before feature styles.
- `apps/web/src/theme/ThemeWorkbench.tsx`
  - Development/test harness that renders themed controls under the real app provider.
- `apps/web/src/theme/ThemeWorkbench.test.tsx`
  - Focused render test for component defaults and class attachment.

Optional after the first pass:

- `apps/web/tests/theme-workbench.spec.ts`
  - Playwright smoke test that opens the workbench and checks that core controls render across at least `oled-black` and `paper-light`.

## Theme Wiring

Update `apps/web/src/theme.ts`:

- Import `createKodexMantineComponents`.
- Add `components: createKodexMantineComponents()` inside `createTheme(...)`.
- Consider also moving common global Mantine defaults here:
  - `defaultRadius: "sm"` or explicit `radius` values if they match existing `--kodex-radius-*`.
  - `cursorType: "pointer"` if we want consistent interactive cursors.
  - `activeClassName: ""` if we want to replace the current `.mantine-active:active { transform: none; }` rule.

Do not make `createKodexMantineComponents` depend on a specific color scheme object. Component classes should reference CSS variables so they automatically track `data-kodex-color-scheme`.

## Component Defaults

### Inputs

Apply to `TextInput`, `Textarea`, `Select`, and `NumberInput`.

Defaults:

- `size: "sm"` unless a component explicitly asks for another size.
- `radius: "md"` or the nearest Mantine radius matching `--kodex-radius-md`.
- `classNames` for `root`, `label`, `input`, `description`, `error`, and `section` where supported.

CSS target:

```css
.kodex-mantine-input {
  border-color: var(--kodex-border-subtle);
  background: var(--kodex-bg-raised-muted);
  color: var(--kodex-text-primary);
}

.kodex-mantine-input:focus,
.kodex-mantine-input:focus-within {
  border-color: var(--kodex-border-accent-soft);
}
```

Also cover:

- placeholder color
- disabled state
- invalid/error state using `--kodex-danger` and `--kodex-bg-danger`
- input sections/icons using `--kodex-text-muted`
- dropdown option surfaces for `Select` through `Combobox`/`Select` selectors if Mantine exposes the needed selectors in v8

Migration targets:

- Keep composer textareas local because they are custom editor surfaces.
- Remove baseline input color/border duplication from `.kodex-sidebar-search input` once the global input default is good; keep sidebar-specific height and radius there.
- Remove baseline styling expectations from `kodex-automation-mobile-input`; keep mobile `min-height: 44px` and `font-size: 16px` overrides in `automations.css`.

### Menus

Apply to `Menu`, `MenuDropdown`, `MenuItem`, `MenuLabel`, and `MenuDivider` using Mantine compound component names where required.

Move the current defaults from `apps/web/src/styles/base.css`:

- `.mantine-Menu-dropdown`
- `.mantine-Menu-label`
- `.mantine-Menu-divider`
- `.mantine-Menu-dropdown [data-menu-item]`
- hover and active item state rules

CSS classes:

- `.kodex-mantine-menu-dropdown`
- `.kodex-mantine-menu-label`
- `.kodex-mantine-menu-divider`
- `.kodex-mantine-menu-item`
- `.kodex-mantine-menu-item-section`
- `.kodex-mantine-menu-item-label`

Keep feature-specific menu layouts local:

- Composer run-setting chips in `composer.css`.
- Permission preset rows in `composer.css`.
- Account settings dropdown content in account/sidebar CSS.

### Modals And Drawers

Apply to `Modal` and `Drawer`.

Move default surface styling out of broad global selectors:

- `.mantine-Modal-content`
- `.mantine-Modal-header`
- `.mantine-Modal-close`
- `.kodex-markdown-preview-pane .mantine-Drawer-content`

CSS classes:

- `.kodex-mantine-modal-content`
- `.kodex-mantine-modal-header`
- `.kodex-mantine-modal-body`
- `.kodex-mantine-modal-close`
- `.kodex-mantine-drawer-content`
- `.kodex-mantine-drawer-header`
- `.kodex-mantine-drawer-body`
- `.kodex-mantine-drawer-close`

Keep feature-specific modal layout local:

- `PreferencesModal` can drop `content` and `header` class overrides if the defaults match, but should keep `body: "kodex-preferences-modal-body"` because the preferences layout needs zero body padding.
- Automation mobile full-screen modal rules should stay in `automations.css`.

### Buttons And Action Icons

Apply to `Button` and `ActionIcon`.

Defaults:

- `radius: "sm"` for normal controls.
- `variant: "subtle"` for `ActionIcon`.
- Keep `Button` default variant conservative. Do not globally force every button to `light` or `filled`; the app uses both semantic primary and quiet secondary actions.

CSS classes:

- `.kodex-mantine-button-root`
- `.kodex-mantine-button-inner`
- `.kodex-mantine-button-label`
- `.kodex-mantine-button-section`
- `.kodex-mantine-action-icon-root`

Migrate repeated internal label fixes where safe:

- `.kodex-composer-control .mantine-Button-label`
- `.kodex-approval-action .mantine-Button-label`
- `.kodex-approval-action .mantine-Button-inner`
- `.kodex-approval-action .mantine-Button-section`

Keep action-specific colors local:

- Composer send/stop action states.
- Approval positive/danger/neutral tones.
- Delete confirmation states.

### Badges And Semantic Tones

Current `.kodex-ui-badge` plus `data-tone` is useful and should remain.

Add `Badge` default class names so new badges have correct radius, border handling, and typography. Do not remove `data-tone`; it is the current semantic tone API for non-Mantine status colors.

Potential follow-up: add a small `KodexBadge` wrapper only if repeated `className="kodex-ui-badge" data-tone=...` remains noisy after `theme.components`.

### Tabs And Segmented Controls

Apply to `Tabs`, `TabsList`, `TabsTab`, `TabsPanel`, and `SegmentedControl`.

Defaults:

- Panel text/background should align with `--kodex-bg-panel`.
- Tab hover/active states should use `--kodex-bg-button-hover`, `--kodex-bg-selected`, and `--kodex-text-primary`.
- Segmented control should use raised-muted surfaces and selected accent states.

Migration targets:

- Automation prompt editor mobile tabs currently target `.kodex-automation-prompt-editor .mantine-Tabs-tab`; keep only mobile sizing there.
- Markdown preview mode `SegmentedControl` should look native without local styling.

### Alerts

Apply to `Alert`.

Use default classes to align border radius, background, and title/body colors. Error alerts should use the existing red tuple plus `--kodex-bg-danger` where appropriate.

Migration target:

- Automation editor error alert should not need extra feature styling.

## Theme Workbench

Add a development-only harness that renders the real controls under the real `MantineProvider`.

Implementation options:

1. Add a route-like branch in `App` when `window.location.pathname === "/__theme"`.
2. Or export a standalone `ThemeWorkbenchApp` from the theme folder and mount it from a dedicated Vite HTML page.

Prefer option 1 for minimal setup.

Workbench content:

- Color scheme switcher using existing `KODEX_COLOR_SCHEMES`.
- Form controls:
  - `TextInput`, `Textarea`, `Select`, `NumberInput`
  - normal, focused-friendly, disabled, error
- Overlays:
  - `Menu` with normal, active, danger, checkbox-like item
  - `Modal`
  - `Drawer`
- Controls:
  - `Button` variants: default, subtle, light, filled, danger
  - `ActionIcon` variants: subtle, light, filled
  - `Badge` tones
  - `Tabs`
  - `SegmentedControl`
  - `Alert`

The workbench should use app CSS and the same color-scheme persistence functions as the real app.

## Test Plan

Unit/component tests:

- Add `ThemeWorkbench.test.tsx` to render workbench with `MantineProvider theme={createKodexMantineTheme(...)}`.
- Assert that core components mount with the expected Kodex classes from `theme.components`.
- Assert that switching the Kodex color scheme updates `data-kodex-color-scheme` and `data-mantine-color-scheme`.

Focused regression tests:

- Update tests that depend on old internal class selectors only if they break.
- Avoid testing implementation-only class names broadly outside the workbench; feature tests should continue to prefer roles and visible text.

Playwright smoke:

- Add a single `theme-workbench.spec.ts` if the first implementation changes enough visual surface to warrant browser verification.
- Test `oled-black` and `paper-light`.
- Verify the page has no blank controls and that representative input/menu/modal/drawer surfaces are visible.

Manual QA:

- Open `/__theme`.
- Check all named color schemes.
- Add one throwaway plain `TextInput`, `Select`, and `Menu` in an existing feature locally while developing to confirm no feature-specific class is needed for baseline styling.

## Implementation Milestones

### Milestone 1: Component Theme Scaffold

Status: Proposed

Implementation:

- Add `theme/components.ts`.
- Add `styles/mantine-components.css`.
- Wire `components` into `createKodexMantineTheme`.
- Import `mantine-components.css` from `App.css`.
- Add the workbench component behind `/__theme`.

Exit conditions:

- `cd apps/web && npm test` passes.
- Existing app screens look unchanged except for acceptable small default-control alignment.
- `/__theme` renders under each Kodex color scheme.

### Milestone 2: Inputs, Menus, Modals, Drawers

Status: Proposed

Implementation:

- Add default `theme.components` entries for inputs, menus, modals, and drawers.
- Move broad global menu/modal/drawer CSS from `base.css` and `timeline.css` into `mantine-components.css` classes.
- Reduce feature CSS to layout-only where possible.

Exit conditions:

- Plain `TextInput`, `Select`, `Textarea`, `Menu`, `Modal`, and `Drawer` render with Kodex chrome in the workbench.
- Automation editor fields still meet mobile touch-size requirements.
- Preferences modal and markdown drawer retain their expected layout.

### Milestone 3: Buttons, Badges, Tabs, Segmented Controls, Alerts

Status: Proposed

Implementation:

- Add defaults/classes for `Button`, `ActionIcon`, `Badge`, `Tabs`, `SegmentedControl`, and `Alert`.
- Move repeated Mantine internal button label/section fixes into default classes when safe.
- Keep custom semantic tone classes for approval/composer statuses.

Exit conditions:

- New buttons/action icons have baseline Kodex sizing, radius, and hover/focus behavior.
- Existing composer, approval, automation, sidebar, and thread header actions keep their current semantics.
- Workbench covers all migrated component categories.

### Milestone 4: Cleanup And Guardrail

Status: Proposed

Implementation:

- Remove broad `.mantine-*` app-policy selectors that have been replaced.
- Leave documented, scoped `.mantine-*` selectors only where Mantine v8 does not expose a stable `classNames` selector for the needed inner element.
- Add a short contributor note to `AGENTS.md` or an existing frontend plan if this becomes a standing convention:
  - Use plain Mantine controls first.
  - Add app-wide control chrome in `theme.components`.
  - Add feature CSS only for layout or one-off behavior.

Exit conditions:

- `rg '\\.mantine-' apps/web/src/styles` shows only documented exceptions.
- `cd apps/web && npm test` passes.
- `cd apps/web && npm run build` passes.
- If Playwright coverage is added, `cd apps/web && npm run test:e2e -- theme-workbench` passes.

## Risks And Mitigations

- Risk: `theme.components` class names do not cover every Mantine inner element needed.
  - Mitigation: keep narrowly scoped feature selectors as documented exceptions.
- Risk: Global defaults subtly change dense composer/sidebar layouts.
  - Mitigation: migrate in component groups and verify composer, sidebar, automations, preferences, and markdown drawer after each group.
- Risk: CSS specificity fights with existing feature classes.
  - Mitigation: make default classes low-specificity and let feature classes override layout/density.
- Risk: The workbench becomes a design system project.
  - Mitigation: keep it as a smoke surface only; defer Storybook until we need external review, documented component states, or visual regression infrastructure.

## Completion Criteria

- New plain Mantine form controls and dropdowns inherit Kodex visual chrome without feature-specific classes.
- The broad app-policy `.mantine-*` selectors in base styles are removed or documented as exceptions.
- The workbench demonstrates all themed component categories across at least one dark and one light Kodex scheme.
- Tests and build pass.
