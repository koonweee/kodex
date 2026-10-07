# Theme contrast and surface guidelines

Kodex themes use one semantic color contract for app surfaces and Mantine controls. Read this guide and [`src/theme/tokenContract.ts`](../apps/web/src/theme/tokenContract.ts) before adding a theme, changing a color role, or styling a new surface. A theme is ready only when its typed definition, rendered contrast gate and visual review agree.

## Source of truth and ownership

- [`src/theme/tokenContract.ts`](../apps/web/src/theme/tokenContract.ts) defines the required token keys and ten-color palette tuples. Every theme in [`src/themeRegistry.ts`](../apps/web/src/themeRegistry.ts) supplies the complete contract. Do not hide a missing token with a fallback to another theme or an unchecked cast.
- [`src/theme.ts`](../apps/web/src/theme.ts) connects the registry to Mantine. [`src/theme/mantineColors.ts`](../apps/web/src/theme/mantineColors.ts) owns shared variant resolution and status mapping; [`src/styles/mantine-theme.css`](../apps/web/src/styles/mantine-theme.css) bridges Mantine CSS variables to semantic roles. [`src/theme/components.ts`](../apps/web/src/theme/components.ts), [`src/styles/mantine-components.css`](../apps/web/src/styles/mantine-components.css) and [`src/styles/mantine-controls.css`](../apps/web/src/styles/mantine-controls.css) own app-wide control defaults. Fix a shared control in this bridge rather than restyling each caller.
- Feature CSS owns layout, density and feature-specific presentation. Use existing semantic roles for colors. Do not add raw palette indexes (`accent.3`, `theme.colors.gray[6]`), literal control colors, per-theme feature selectors, local readable-text alpha blends or local overrides of Mantine color variables.
- Brand assets, syntax highlighting, terminal ANSI and diff colors have their own semantics. Keep those exceptions explicit and check their actual context; they are not a reason to bypass the contract for surrounding controls or body text. `text-on-accent` remains a deprecated external-brand/image fallback; use `text-on-action` and `text-on-user-bubble` for normal controls and chat content.

The registry and its bootstrap generation remain the single source of theme values. The expanded catalog uses `theme/themePalettes.ts` foundations and `theme/paletteTheme.ts` to derive the complete contract; see [palette sources and adaptations](theme-palettes.md). A typed complete theme prevents missing roles and malformed palettes; it does not prove that the resulting color pairs are readable.

## Appearance selection

Appearance has a mode (`auto`, `light` or `dark`) plus independent light/dark theme IDs. Auto resolves the system media preference live; explicit modes ignore it. The card filter only controls which candidates are shown: choosing an inactive slot does not change mode. These are browser-local visual preferences, synchronized across tabs of the same origin, not account or gateway settings.

`theme/appearancePreferences.ts` owns validation and resolution shared by the initial HTML bootstrap and React. `appearanceStorage.ts` owns storage/migration, and `useAppearancePreferences.ts` subscribes to system changes and preference updates. Preserve the same first-paint and live resolution rules when extending them. Existing `kodex-color-scheme` values migrate to an explicit mode; new profiles default to Auto with Paper Light and OLED Black. Never persist system-triggered theme changes as explicit user selections.

Palette-preview cards intentionally render candidate semantic pairs independently of the active theme. Their selection/focus chrome still uses the active theme's shared control styles. Focus is a thin, desaturated shared `focus-ring` outline with the shared offset, and must remain visible against adjacent surfaces. Text inputs and textareas intentionally omit focus rings and keep their normal control boundaries while focused. Buttons, selection controls and composer toolbar controls retain their shared keyboard focus indicators.

## Scrollbars

Kodex scrollbars use shared aliases in `styles/ui.css`: `scrollbar-thumb` derives from `border-control`, and `scrollbar-thumb-hover` derives from `text-secondary`. Tracks stay transparent. Native overflow uses the standard thin scrollbar setting with a rounded 6px WebKit fallback; the browser and operating system determine the exact standard thickness. See the [CSS Scrollbars specification](https://drafts.csswg.org/css-scrollbars/).

Mantine keeps its 8px drag lane with a 4px painted thumb. The terminal keeps xterm's 14px drag lane with a 6px painted thumb; CSS owns its colors so theme changes apply live. Dockview uses the same thumb alias. Intentionally hidden tab-strip and terminal accessory scrollbars remain hidden. Sandboxed generated apps and MCP app documents own their inner scrollbar styling.

The contrast gate includes native resting colors, Mantine resting/hover colors, and live theme changes. `tests/scrollbars.spec.ts` checks native keyboard scrolling and horizontal overflow at desktop, narrow fine-pointer and narrow touch shapes, plus Mantine dragging with a fine pointer. Opt-in captures also exercise real xterm dragging and terminal thumb contrast across all themes without starting a shell:

```sh
KODEX_SCROLLBAR_AUDIT_DIR=../../artifacts/scrollbar-audit npx playwright test tests/scrollbars.spec.ts --workers=1
```

These ignored captures show the workbench's native, Mantine and terminal scrollbars. Physical-device overlay rendering and older WebKit fallback behavior still require their own browser checks.

## Safe role pairings

The names below omit the `--kodex-` CSS-variable prefix. Keep the foreground and background together when authoring and reviewing a surface. A role validated on one surface is not permission to use it on every surface.

| Surface or state | Pairing | Authoring rule |
| --- | --- | --- |
| App canvas / sidebar | `bg-app`, `bg-sidebar` with `text-primary` or `text-secondary` | Use background roles as backgrounds, not as text colors. |
| Main content / dialog | `bg-panel` + `text-primary` | Default for body content and headings. |
| Raised surface / menu / popover | `bg-raised` + `text-primary` or `text-secondary` | Validate nested and portal surfaces in the browser. |
| Supporting labels / descriptions | `text-secondary` | Default for readable supporting text and active controls. |
| De-emphasized content | `text-muted` on an explicitly validated surface | Do not apply opacity to readable text. Use primary/secondary on selected, hover and tinted status surfaces unless a rendered check proves the muted pair. |
| Links | `text-accent` on a validated background | Preserve an appropriate non-color affordance. Brand `accent` is not a body-text role. |
| Selected item | `bg-selected` or `bg-selected-strong` + `text-primary` | Keep selected content readable; do not take a shade from a Mantine ramp. |
| Hovered item | `bg-button-hover` + `text-primary` or `text-secondary` | Check hover as a separate pair, especially in light themes. |
| Solid primary action | `bg-action` / `bg-action-hover` + `text-on-action` | Use the foreground on both fills; normal labels need ≥4.5:1 and essential icons ≥3:1. Shared compound controls use the same pairing. |
| User message | `bg-user-bubble` + `text-on-user-bubble` | Bubble text has a separate foreground from actions. Check Markdown, links and nested annotations on their effective backgrounds. |
| Semantic status | `bg-{tone}`, `border-{tone}`, `text-{tone}` | Tone is danger/warning/success/info. Keep the triplet together and convey meaning through text/icon as well. |
| Essential control boundary | `border-control` | Check ≥3:1 against relevant adjacent surfaces when the boundary identifies the control or state. |
| Keyboard focus on non-text controls | `focus-ring` | Check ≥3:1 against adjacent surfaces and visually inspect the visible ring; do not alias it to a translucent decorative border. |
| Decorative divider | `border-subtle` | Decorative separation only; do not substitute it for an essential boundary or focus indicator. |
| Disabled control | Shared disabled styling | Only for unavailable controls. Ordinary metadata is readable supporting text. |

A new component usually needs no new token. Add a role only when a concrete surface/state cannot use an existing pairing; explain the foreground/background need, implement it in the typed contract and every theme, update the bridge if relevant, and extend the rendered specimens and gate in the same change. Do not add a selected-text role unless an actual theme demonstrates that `text-primary` cannot cover the selected fill.

## Mantine controls and semantic status

Prefer plain Mantine controls. The shared bridge resolves action variants and Mantine body, default surface/text/border, dimmed, placeholder, error and focus colors to semantic roles. Use the shared Button and ActionIcon variants without selecting ramp shades or supplying local contrast fixes. Filled status controls resolve through the same status foreground/background pair, inverted centrally for the solid variant. Compound components such as Checkbox, Radio, Switch and Progress need browser checks of their selected marks, labels and fills too.

Use `color="red"` for danger, `color="yellow"` (or the shared `orange` alias) for warning, `color="green"` for success and `color="blue"` for info on supported status controls. Badge also supports `data-tone="danger|warning|success|info"` when an explicit semantic tone is needed. The shared mapping must produce the same status meaning for Badge and Alert. Do not assume a Mantine prop appears as a DOM `data-color` attribute, and do not invent a feature-level selector that depends on it. An additional color alias needs an explicit shared mapping and rendered coverage before use.

Changing a theme must recompute live Mantine styles and portaled surfaces as well as root tokens. A passing palette swatch or panel-text ratio cannot establish that a filled button, selected indicator or nested menu is correct.

## Required agent workflow

1. Read this guide and the typed token contract. Inspect the existing component/default and role usage before editing. Choose the semantic foreground/background pair for each normal, selected, hover, error and focus state.
2. Change the registry and shared bridge for shared color behavior. Keep feature files focused on layout and legitimate feature presentation. Explain any new role or exceptional non-contract color in review.
3. Add or extend a representative specimen in [`ThemeWorkbench.tsx`](../apps/web/src/theme/ThemeWorkbench.tsx) and a rendered assertion in [`tests/theme-contrast.spec.ts`](../apps/web/tests/theme-contrast.spec.ts) when changing a shared role, control mapping or contrast behavior. Assertions should measure effective colors and state meaning, not CSS strings, class names or fixed hex values.
4. Run the contrast gate for every shipped theme, plus build/typecheck and trim. Gate tests are routine Playwright tests; they do not require the contact-sheet output environment variable.
5. Capture and inspect the theme matrix for palette/bridge changes and new surface pairings. Review actual screens as well as specimens, including portals, placeholders, hover, keyboard focus, disabled/error states and nested bubble/Markdown content. Extend captures for newly introduced primitives or contexts. For changes affecting layout and input modality, include desktop fine pointer, narrow fine pointer and narrow touch.
6. Record the executed checks and material coverage limits. Review the full diff for local overrides that would bypass the bridge. Do not declare a new theme or surface ready while a relevant rendered assertion fails or visual evidence remains unresolved.

From `apps/web`:

```sh
npx playwright test tests/theme-contrast.spec.ts --workers=1
npm run build
npm run trim
KODEX_THEME_AUDIT_DIR=../../artifacts/theme-audit npx playwright test tests/theme-contact-sheet.spec.ts --workers=1
python3 scripts/build-theme-contact-sheet.py ../../artifacts/theme-audit
```

The contact-sheet builder needs Pillow in the chosen Python environment. Captures use the existing disposable Playwright Vite server on localhost:5174 and synthetic native-settings fixtures; they do not inspect or mutate the running gateway or user chats. Without `KODEX_THEME_AUDIT_DIR`, diagnostic capture tests skip; the contrast gate still runs. The builder rejects missing required captures. New runs write per-theme manifests; the gallery includes every captured theme and paginates PNG comparisons into groups of four. Give a new evidence run a separate output directory when preserving an earlier comparison.

## Measurement and review limits

Normal readable text, including placeholders and helper text, needs ≥4.5:1. Aim above the threshold for small or light-weight text. Large text may use ≥3:1 under the WCAG size/weight definition. Essential icons, control boundaries and state/focus indicators need ≥3:1 against applicable adjacent colors. Disabled controls and decorative separators have different applicability; identify them explicitly. Evaluate unrounded ratios and composite alpha before calculating contrast.

The rendered gate protects the pairs and states it explicitly exercises. Contact-sheet measurements resolve computed sRGB colors and composite transparent backgrounds through DOM ancestors. Modal samples exclude the dimmed app below. Gradients, opacity chains, overlapping siblings, clipped content, pseudo-elements, SVG strokes and native control glyphs require visual review; a diagnostic border sample is not proof of every adjacent edge. These checks do not constitute complete WCAG conformance certification.

Reference thresholds: [W3C text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [W3C non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html).

## Historical audit: 6 October 2026

The pre-fix baseline used checkout `e2ef807` plus workbench specimens, Chromium and the four shipped themes. It exposed separate Mantine/Kodex color selection, shared action/bubble foregrounds, decorative input/focus borders and ineffective Alert/Badge color mapping. These findings motivated the current contract; the baseline ratios below describe that earlier checkout, not current acceptance evidence.

| Baseline rendered pairing | OLED Black | Paper Light | Dracula | Monokai |
| --- | ---: | ---: | ---: | ---: |
| Subtle button label / panel | 10.68 | 3.37 | 1.69 | 2.94 |
| Filled button label / fill | 2.94 | 3.52 | 1.84 | 1.31 |
| Filled action icon / fill | 1.91 | 2.86 | 1.38 | 1.04 |
| Mantine dimmed text / panel | 4.75 | 3.73 | 3.56 | 4.08 |

Historical generated outputs are ignored local artifacts: [comparison gallery](../artifacts/theme-audit/index.html), [overview](../artifacts/theme-audit/contact-sheet.png), [primitives](../artifacts/theme-audit/primitives-contact-sheet.png), [overlays](../artifacts/theme-audit/overlays-contact-sheet.png) and [states](../artifacts/theme-audit/states-contact-sheet.png). Theme subdirectories contain full captures, detail crops, `measurements.json` and `touch-measurements.json`. These links require the local capture output; regenerate with the commands above when absent. The capture matrix covers primitives, chat/Markdown, preferences, notifications and narrow/touch preferences. Terminal/diff/file preview, live approvals, MCP Apps, automation forms and physical-device rendering still need their own context-specific review when changed.

## Post-fix validation: 7 October 2026

The combined frontend checkout passed all 1,003 unit/component tests, production build/typecheck and trim. The rendered gate passed all five tests (four themes plus live theme switching against fresh renders). Eight capture flows produced 56 screen/state captures covering the current queue UI, primitives, overlays, preferences and narrow/touch layouts. Independent review found no remaining material issues in this change. Theme labels and swatches now occupy separate columns with a minimum gap, checked in desktop and touch captures.

The regenerated local [comparison gallery](../artifacts/theme-audit-after/index.html), [primitives sheet](../artifacts/theme-audit-after/primitives-contact-sheet.png), [overlays sheet](../artifacts/theme-audit-after/overlays-contact-sheet.png) and [states sheet](../artifacts/theme-audit-after/states-contact-sheet.png) preserve the post-fix evidence separately from the baseline. These ignored artifacts can be reproduced by changing the output directory in the commands above to `theme-audit-after`. Coverage limits listed above still apply; passing this matrix does not certify every product surface.

## Catalog and Auto mode validation: 7 October 2026

The catalog now contains 40 themes (14 light, 26 dark). Validation passed 1,019 unit/component tests, production build/typecheck and trim, plus 125 Chromium checks: 40 per-theme contrast checks, live theme recomputation, Auto/system/two-tab/reload behavior, three responsive picker layouts and 80 capture flows. Focus checks include buttons, text inputs, the composer textarea, switches and segmented controls. The card containment regression failed before intrinsic grid row sizing was added and now passes in all three responsive layouts.

The ignored local [catalog gallery](../artifacts/theme-catalog/index.html) contains 560 screen/state captures, with comparison sheets paginated four themes at a time. Use `KODEX_THEME_AUDIT_DIR=../../artifacts/theme-catalog` with the capture command above, then build that directory. The workbench capture uses a taller viewport to include all primitives below the expanded theme chooser. Upstream palette provenance and adaptation details are in [theme palette sources](theme-palettes.md). Independent implementation reviews covered appearance state, first-paint behavior, storage failures, the picker, palette generation, shared focus styling and capture generation; the context-specific coverage limits above still apply.
