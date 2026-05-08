# Mantine Local Style Cleanup Checklist

## Status

Complete.

## Scope

Reduce local one-off component chrome where Mantine components and existing theme defaults can carry the baseline styling. Keep feature layout, density, responsive behavior, and content-specific rendering local.

## Checklist

- [x] Move composer footer control and run-settings menu chrome toward themed `Button`, `Menu.Item`, and `Switch` defaults.
- [x] Remove duplicated Preferences modal surface/header chrome in favor of themed `Modal` defaults.
- [x] Convert Preferences section and color-scheme choices away from custom native button chrome.
- [x] Convert the Automations add action away from custom native button chrome.
- [x] Replace the custom checkbox menu item switch/chrome with Mantine-backed menu item styling where practical.
- [x] Remove local Sidebar settings `ActionIcon` hover/active chrome that duplicates theme defaults.
- [x] Remove Approval action button chrome that duplicates themed `Button` defaults.
- [x] Move semantic badge tone styling from `kodex-ui-badge` callers to themed `Badge` defaults.

## Verification

- `cd apps/web && npm test -- ThemeWorkbench.test.tsx App.automations.test.tsx ComposerFooterControls.test.tsx`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- `git diff --check`
