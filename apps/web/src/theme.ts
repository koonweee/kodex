import { createTheme, type MantineColorsTuple, type MantineThemeOverride } from "@mantine/core";

import { createKodexMantineComponents } from "./theme/components";
import {
  DEFAULT_KODEX_COLOR_SCHEME_ID,
  getKodexColorSchemeDefinition,
  isKodexColorSchemeId,
  KODEX_COLOR_SCHEME_STORAGE_KEY,
  KODEX_COLOR_SCHEMES as KODEX_COLOR_SCHEME_DEFINITIONS,
  type KodexColorSchemeDefinition,
  type KodexColorSchemeId,
} from "./themeRegistry";

type KodexColorSchemeBase = Omit<KodexColorSchemeDefinition, "mantineAccent" | "mantineGray" | "mantineRed">;

export type KodexColorScheme = KodexColorSchemeBase & {
  mantineAccent: MantineColorsTuple;
  mantineGray: MantineColorsTuple;
  mantineRed: MantineColorsTuple;
};

const FONT_FAMILY =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const KODEX_COLOR_SCHEMES: KodexColorScheme[] = KODEX_COLOR_SCHEME_DEFINITIONS.map((scheme) => ({
  ...scheme,
  mantineAccent: scheme.mantineAccent as unknown as MantineColorsTuple,
  mantineGray: scheme.mantineGray as unknown as MantineColorsTuple,
  mantineRed: scheme.mantineRed as unknown as MantineColorsTuple,
}));

const COLOR_SCHEME_BY_ID = new Map(KODEX_COLOR_SCHEMES.map((scheme) => [scheme.id, scheme]));

export { DEFAULT_KODEX_COLOR_SCHEME_ID, KODEX_COLOR_SCHEME_STORAGE_KEY, type KodexColorSchemeId };

export function getKodexColorScheme(colorSchemeId: KodexColorSchemeId): KodexColorScheme {
  return COLOR_SCHEME_BY_ID.get(colorSchemeId) ?? COLOR_SCHEME_BY_ID.get(DEFAULT_KODEX_COLOR_SCHEME_ID)!;
}

export function readStoredKodexColorScheme(): KodexColorSchemeId {
  if (typeof window === "undefined" || typeof window.localStorage?.getItem !== "function") {
    return DEFAULT_KODEX_COLOR_SCHEME_ID;
  }

  try {
    const storedValue = window.localStorage.getItem(KODEX_COLOR_SCHEME_STORAGE_KEY);
    return storedValue && isKodexColorSchemeId(storedValue) ? storedValue : DEFAULT_KODEX_COLOR_SCHEME_ID;
  } catch {
    return DEFAULT_KODEX_COLOR_SCHEME_ID;
  }
}

export function writeStoredKodexColorScheme(colorSchemeId: KodexColorSchemeId) {
  if (typeof window === "undefined" || typeof window.localStorage?.setItem !== "function") {
    return;
  }

  try {
    window.localStorage.setItem(KODEX_COLOR_SCHEME_STORAGE_KEY, colorSchemeId);
  } catch {
    // Ignore persistence failures and keep the in-memory preference.
  }
}

export function applyKodexColorScheme(
  root: HTMLElement,
  colorScheme: Pick<KodexColorSchemeDefinition, "id" | "mode">,
) {
  root.setAttribute("data-kodex-color-scheme", colorScheme.id);
  root.setAttribute("data-mantine-color-scheme", colorScheme.mode);
}

export function clearKodexColorScheme(root: HTMLElement) {
  root.removeAttribute("data-kodex-color-scheme");
  root.removeAttribute("data-mantine-color-scheme");
}

export function initializeKodexColorScheme(root: HTMLElement = document.documentElement): KodexColorSchemeId {
  const colorSchemeId = readStoredKodexColorScheme();
  applyKodexColorScheme(root, getKodexColorSchemeDefinition(colorSchemeId));
  return colorSchemeId;
}

export function createKodexMantineTheme(colorScheme: KodexColorScheme): MantineThemeOverride {
  return createTheme({
    primaryColor: "accent",
    colors: {
      accent: colorScheme.mantineAccent,
      gray: colorScheme.mantineGray,
      red: colorScheme.mantineRed,
    },
    fontFamily: FONT_FAMILY,
    defaultRadius: "sm",
    cursorType: "pointer",
    activeClassName: "",
    headings: {
      fontFamily: FONT_FAMILY,
    },
    components: createKodexMantineComponents(),
  });
}
