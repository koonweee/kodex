import { createTheme, type MantineThemeOverride } from "@mantine/core";

import { resolveAppearanceScheme } from "./theme/appearancePreferences";
import { readStoredAppearancePreferences, systemPrefersDark, writeStoredAppearancePreferences } from "./theme/appearanceStorage";
import { createKodexMantineComponents } from "./theme/components";
import { kodexVariantColorResolver } from "./theme/mantineColors";
import {
  DEFAULT_KODEX_COLOR_SCHEME_ID,
  getKodexColorSchemeDefinition,
  KODEX_COLOR_SCHEMES as KODEX_COLOR_SCHEME_DEFINITIONS,
  type KodexColorSchemeDefinition,
  type KodexColorSchemeId,
} from "./themeRegistry";

export type KodexColorScheme = KodexColorSchemeDefinition;

const FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const KODEX_COLOR_SCHEMES: KodexColorScheme[] = KODEX_COLOR_SCHEME_DEFINITIONS;

const COLOR_SCHEME_BY_ID = new Map(KODEX_COLOR_SCHEMES.map((scheme) => [scheme.id, scheme]));

export { DEFAULT_KODEX_COLOR_SCHEME_ID, type KodexColorSchemeId };

export function getKodexColorScheme(colorSchemeId: KodexColorSchemeId): KodexColorScheme {
  return COLOR_SCHEME_BY_ID.get(colorSchemeId) ?? COLOR_SCHEME_BY_ID.get(DEFAULT_KODEX_COLOR_SCHEME_ID)!;
}

/** Resolved device appearance; retained for standalone theme consumers. */
export function readStoredKodexColorScheme(): KodexColorSchemeId {
  return resolveAppearanceScheme(readStoredAppearancePreferences(), systemPrefersDark());
}

/** Explicit theme selection for workbench/legacy callers. */
export function writeStoredKodexColorScheme(colorSchemeId: KodexColorSchemeId) {
  const scheme = getKodexColorSchemeDefinition(colorSchemeId);
  writeStoredAppearancePreferences({
    ...readStoredAppearancePreferences(),
    mode: scheme.mode,
    [scheme.mode === "light" ? "lightThemeId" : "darkThemeId"]: scheme.id,
  });
}

export function applyKodexColorScheme(
  root: HTMLElement,
  colorScheme: Pick<KodexColorSchemeDefinition, "id" | "mode">,
) {
  root.setAttribute("data-kodex-color-scheme", colorScheme.id);
  root.setAttribute("data-mantine-color-scheme", colorScheme.mode);
}

export function initializeKodexColorScheme(root: HTMLElement = document.documentElement): KodexColorSchemeId {
  const colorSchemeId = readStoredKodexColorScheme();
  applyKodexColorScheme(root, getKodexColorSchemeDefinition(colorSchemeId));
  return colorSchemeId;
}

export function createKodexMantineTheme(colorScheme: KodexColorScheme): MantineThemeOverride {
  return createTheme({
    primaryColor: "accent",
    variantColorResolver: kodexVariantColorResolver,
    focusClassName: "kodex-mantine-focus",
    colors: {
      accent: colorScheme.mantineAccent,
      gray: colorScheme.mantineGray,
      red: colorScheme.mantineRed,
    },
    fontFamily: FONT_FAMILY,
    defaultRadius: "md",
    radius: {
      xs: "var(--kodex-radius-xs)",
      sm: "var(--kodex-radius-sm)",
      md: "var(--kodex-radius-md)",
      lg: "var(--kodex-radius-lg)",
      xl: "var(--kodex-radius-xl)",
    },
    cursorType: "pointer",
    activeClassName: "",
    headings: {
      fontFamily: FONT_FAMILY,
    },
    components: createKodexMantineComponents(),
  });
}
