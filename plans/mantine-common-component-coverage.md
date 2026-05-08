# Mantine Common Component Coverage Checklist

## Status

Complete.

## Scope

Extend the app-wide Mantine theme defaults and `/__theme` workbench coverage to the next common component groups, then clean up one-off styling only where the styling is baseline chrome rather than feature layout.

This remains frontend-only. It does not change gateway APIs, OpenAPI output, app-server behavior, or shared thread state ownership.

## Checklist

- [x] Add app-wide defaults for selection controls: `Checkbox`, `Switch`, `Radio`.
- [x] Add app-wide defaults for searchable inputs: `Autocomplete`, `MultiSelect`, `Combobox`.
- [x] Add app-wide defaults for contextual overlays: `Popover`, `Tooltip`.
- [x] Add app-wide defaults for data/surface primitives: `Table`, `Paper`, `ScrollArea`.
- [x] Add app-wide defaults for loading states: `Loader`, `Progress`, `Skeleton`.
- [x] Extend `/__theme` with visible examples for each new component group.
- [x] Extend focused workbench tests to assert default class attachment for each group.
- [x] Audit existing one-off theming and move only baseline chrome into `theme.components`/`mantine-components.css`.
- [x] Keep composer-specific density/layout exceptions scoped and documented.
- [x] Verify with focused tests, full frontend tests, build, and agent-browser desktop/mobile smoke.
- [x] Run an independent review pass before completion.

## Verification

- `cd apps/web && npm test -- ThemeWorkbench.test.tsx`
- `cd apps/web && npm test`
- `cd apps/web && npm run build`
- `agent-browser` smoke on `/__theme` for desktop and mobile, including overlays and color-scheme switching.
