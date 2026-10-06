# Theme contrast and surface guidelines

The existing registry is a good starting point, but **new themes are not yet safe by default**. Kodex surface/text tokens and Mantine's generated colors currently form two partially independent systems. Finish the shared bridge and pairing work below before treating a new palette as production ready.

This document records the 6 October 2026 audit and the authoring contract it motivates. Proposed tokens are explicitly marked; they do not exist yet. This audit adds specimens, capture tooling and guidance, not production palette fixes.

## Evidence and reproduction

The baseline uses checkout `e2ef807` plus the added workbench specimens, Chromium, four shipped themes, and synthetic data served through the existing native-settings test fixture. It does not read or mutate the running gateway or user chats.

From `apps/web`:

```sh
KODEX_THEME_AUDIT_DIR=../../artifacts/theme-audit npx playwright test tests/theme-contact-sheet.spec.ts --workers=1
python3 scripts/build-theme-contact-sheet.py ../../artifacts/theme-audit
```

The second command requires Pillow in the chosen Python environment. The capture command uses the existing Playwright setup, including its disposable Vite server on localhost:5174. With no output environment variable, the diagnostic capture tests are skipped. The sheet builder fails if any required capture is absent.

Generated, ignored outputs under `artifacts/theme-audit/`:

- `index.html`: comparison gallery, full-resolution image links and measured contrast table.
- `contact-sheet.png`: overview of primitives, chat, preferences, notifications and touch.
- `primitives-contact-sheet.png`, `overlays-contact-sheet.png`, `states-contact-sheet.png`: larger comparisons by category.
- Theme directories: 14 full screen captures each, additional dialog/menu detail crops, `measurements.json`, and `touch-measurements.json`.

Coverage: TextInput, Textarea, Select, NumberInput, Autocomplete, MultiSelect/pills, Checkbox, Radio, Switch, Button variants, ActionIcon, Badge, Alert, Menu, Combobox trigger, Popover, Tooltip, Modal, Drawer, Tabs, SegmentedControl, Paper, Table, ScrollArea, Loader, Progress/label, Skeleton; plus actual sidebar/docking, composer, user bubble, Markdown heading/body/link/inline code/code block/blockquote/table/list, preferences and notifications. Disabled, error, selected, unchecked, input focus, keyboard button focus and subtle-button hover are represented. Preferences also have 390px fine-pointer and emulated touch captures.

This is broad visual coverage, not exhaustive state coverage: autocomplete/multiselect menus, every hover/focus/error combination, terminal ANSI output, diff/file preview, live approval prompts, MCP Apps, automation forms, and physical-device rendering need a follow-up sweep when implementing fixes. The always-visible tooltip is an intentional workbench specimen.

Measurements use computed sRGB colors, compositing transparent backgrounds through DOM ancestors. Modal measurements exclude the dimmed underlying app. Gradients and opacity chains are flagged unsupported; border ratios are diagnostic outer-edge samples, not automatic failures. Portals, overlapping siblings, clipped content, pseudo-elements, SVG strokes and native checkbox/radio glyphs still require visual review. These samples are not a WCAG conformance certification.

## Findings and required tweaks

Ratios below are from the rendered primitive workbench. Normal text needs at least 4.5:1; the action-icon row needs 3:1. A ratio printed to two decimals must still be evaluated using its unrounded value.

| Rendered pairing | OLED Black | Paper Light | Dracula | Monokai |
| --- | ---: | ---: | ---: | ---: |
| Subtle button label / panel | 10.68 | 3.37 | 1.69 | 2.94 |
| Light button label / tinted fill | 9.18 | 3.03 | 1.35 | 2.16 |
| Filled button label / fill | 2.94 | 3.52 | 1.84 | 1.31 |
| Outline button label / panel | 2.25 | 3.37 | 2.43 | 4.25 |
| Filled action icon / fill | 1.91 | 2.86 | 1.38 | 1.04 |
| Mantine `c="dimmed"` / panel | 4.75 | 3.73 | 3.56 | 4.08 |
| Kodex `text-muted` / panel | 5.50 | 4.69 | 6.04 | 5.83 |

### 1. Bridge Mantine variants to semantic pairs first

`src/theme.ts` supplies accent/gray/red ramps but retains default shade selection and variant resolution. Dracula and Monokai accent ramps go dark-to-light, whereas Mantine's dark light/subtle labels select index 3. The screenshot's unreadable purple comes from this mismatch. OLED's differently ordered ramp happens to work for subtle buttons, but fails outline and filled variants.

Add one central variant resolver and semantic CSS-variable bridge. Cover Button and ActionIcon variants and Mantine body, default surface, default text/border, dimmed, placeholder, error and focus colors. Inspect effective styles rather than assuming component props reach DOM attributes. Do not fix Preferences with a local purple override: the same mistake appears in unrelated controls.

### 2. Separate filled-action text from bubble text

`text-on-accent` currently serves both bright accent controls and darker user bubbles. Against `accent` it measures 2.89/4.21/2.26/1.53 across OLED/Paper/Dracula/Monokai. Against the user bubble it measures 5.03/4.21/5.36/4.40. One foreground cannot safely cover both roles.

Introduce a paired solid action background/hover/foreground family and a separate bubble foreground. Dark ink is a good candidate on the bright Dracula/Monokai action fills; their bubbles can keep light ink. Darken Paper's bubble fill or adjust its foreground, and make a small corresponding Monokai bubble correction. Measure actual button hover, checkbox/radio selected marks and progress labels too; compound Mantine components can have a separate styling path.

### 3. Separate essential boundaries from decorative separators

`border-subtle` against the input surface measures only 1.15–1.28. The `border-accent-soft` focus color, composited over a panel, measures 1.43–2.40. These can be attractive decorative colors but are insufficient where a boundary/indicator is necessary to identify a control or its state.

Add an opaque `border-control` and a dedicated `focus-ring`, each checked against its adjacent surfaces at 3:1. Preserve subtle separators where they are decorative. Review focus against both the control and surrounding surface; a two-color ring is an option if one color cannot cover both. Do not globally make every divider high contrast.

### 4. Correct status mapping and light-theme status pairs

The browser specimens show **all four Alert color props (red/yellow/green/blue) rendering with the info pair**. Existing CSS expects `data-color="red"`, which these alerts do not expose. `Badge color="red"` likewise renders neutral, whereas `Badge data-tone="danger"` selects the intended triplet. This is a semantic error in addition to contrast risk.

Choose one explicit mapping in the shared defaults: red → danger, yellow → warning, green → success, blue → info. Keep semantic foreground/background/border triplets together; use icon/title/text to convey meaning too. Verify the rendered result for every supported prop and variant.

Paper's semantic token pairs themselves also need adjustment: danger 4.14, success 3.83, info 4.19. Warning is 5.23. Dark-theme status pairs pass these sampled text comparisons. Fix Paper's foregrounds or tinted surfaces, then retest badges, alerts and inline errors in their actual containers.

### 5. Bound the contexts for muted text

All four `text-muted` tokens pass on the panel, but fail on `bg-selected-strong` (3.66–3.96). Paper has especially little margin: its panel pair is 4.69 and hover pair is 3.64. Do not assume that a passing panel color is safe on every fill. Prefer primary/secondary text on selected, hover and status surfaces; only use muted where its pair is validated.

### 6. Enforce token completeness

`themeRegistry.ts` currently declares `rootVariables: Record<string, string>` and arbitrary `string[]` ramps; `theme.ts` casts them to Mantine tuples. A misspelled/missing token or wrong ramp length can compile.

Define a required semantic token-key union and ten-element palette tuples. Require every theme to supply the full set without silently inheriting another theme's missing values. Keep registry/bootstrap generation as the single source of truth. Validate color *pairs*, not just presence or CSS strings.

## Authoring surfaces now

Prefer plain Mantine controls and fix shared defaults in `src/theme/components.ts`, `src/theme.ts` and `src/styles/mantine-components.css`. Feature CSS owns layout, density and genuine exceptions. The current defaults have the defects above: using the right component is necessary but does not by itself prove contrast.

The following existing-token choices express intent. A surface still needs rendered validation until the bridge/pairing fixes land.

| Surface or content | Existing tokens / convention | Rule |
| --- | --- | --- |
| App canvas / sidebar | `bg-app`, `bg-sidebar` | Background roles, not text colors. |
| Main content / dialog | `bg-panel` + `text-primary` | Body content and headings; avoid raw hex values. |
| Floating / raised surface | `bg-raised` + `text-primary` | Menus, popovers and small raised regions; validate nested surfaces. |
| Supporting text | `text-secondary` | Default choice for labels, descriptions and active controls. |
| De-emphasized text | `text-muted` | Only on validated background pairs; no opacity on readable text. |
| Link | `text-accent` | Include a non-color affordance where needed; check its actual background. |
| Selection | `bg-selected` + `text-primary` | Prefer primary text; do not reuse raw accent ramp shades. |
| Hover | `bg-button-hover` + `text-primary` | Preserve readable text and selected-state meaning. |
| Semantic status | `bg-{tone}`, `border-{tone}`, `text-{tone}` | Tone is danger/warning/success/info; keep the triplet together. Badge supports `data-tone`; Alert mapping still needs repair. |
| Decorative separator | `border-subtle` | Not the required control outline or focus indicator. |
| Disabled | Shared disabled component styling | Only for truly unavailable controls; do not dim normal metadata this way. |
| Bubble / filled action | Existing pairing is unsafe | Use the dedicated paired contract below once implemented; do not spread `text-on-accent` to new roles. |

Avoid raw Mantine palette indexes, literal component colors, local alpha blends for text, or per-theme selectors in feature CSS. Never use `accent` as body text just because it is a brand color. Do not add another surface token merely because a new component exists; add a semantic role only when existing roles cannot express its pairing or state.

## Minimal contract to implement before expanding themes

Retain the existing surface hierarchy and semantic status triplets. Add these roles; exact spelling should remain consistent with the registry when implemented:

| Proposed token family (not yet implemented) | Pairing contract |
| --- | --- |
| `bg-action`, `bg-action-hover`, `text-on-action` | Foreground ≥4.5:1 on both fills; verify essential icon ≥3:1. |
| `text-on-user-bubble` with existing `bg-user-bubble` | Body/Markdown/link content remains readable inside the bubble. |
| `border-control` | Required control boundary ≥3:1 against relevant adjacent fill(s). |
| `focus-ring` | Visible keyboard focus ≥3:1 against adjacent surfaces; no translucent decorative alias. |

No extra selected-text token is necessary yet: `text-primary` covers the current selected fills. Add one only when a concrete theme demonstrates a need. Terminal ANSI and code/diff palettes are separate role sets; do not force them into generic status tokens without checking their semantics.

## Acceptance process for a new theme or surface

1. Define every required token and palette tuple. Keep foreground/fill pairs together in review; do not copy a dark ramp into a light theme mechanically.
2. Resolve Mantine through the semantic bridge. Check simple and compound controls, portals, `c="dimmed"`, default variants, and disabled/error/selected/hover/focus states.
3. Measure normal text (including placeholders and helper text) at ≥4.5:1. Aim above the threshold for small/low-weight text. Large text may use ≥3:1 under WCAG's size/weight definition. Required icons/control state indicators need ≥3:1 against adjacent colors. Disabled controls and purely decorative separators have different applicability; label them explicitly rather than counting them as failures.
4. Check primary/secondary/muted against the surfaces where they are allowed, especially selected/hover/tinted panels. Check every semantic status triplet, both solid-action states and bubble content. Alpha must be composited before calculating ratios.
5. Generate the four-theme matrix (and the new theme), inspect full-resolution captures, and include representative actual screens. Extend the fixture when a new primitive or role is introduced. Include desktop fine pointer, narrow fine pointer and narrow touch for changes involving both layout and input modality.
6. Run build/typecheck and trim plus relevant component tests. A future automated contrast gate should assert rendered semantic pairs and states, not CSS class names or fixed palette hex values. Do not accept a palette merely because its swatches look good.

Reference thresholds: [W3C text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) and [W3C non-text contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). This audit's suggestions are engineering guidance, not a claim of complete accessibility compliance.
