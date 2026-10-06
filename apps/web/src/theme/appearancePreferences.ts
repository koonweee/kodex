import type { KodexColorSchemeId } from "../themeRegistry";

export type AppearanceThemeMode = "light" | "dark";
export type AppearanceMode = "auto" | AppearanceThemeMode;
export type AppearancePreferences = {
  mode: AppearanceMode;
  lightThemeId: KodexColorSchemeId;
  darkThemeId: KodexColorSchemeId;
};

export const APPEARANCE_STORAGE_KEY = "kodex-appearance";
export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  mode: "auto",
  lightThemeId: "paper-light",
  darkThemeId: "oled-black",
};

/** Also serialized into the first-paint script: keep this function self-contained. */
export function parseAppearancePreferences(
  stored: string | null,
  legacy: string | null,
  modes: Record<string, AppearanceThemeMode>,
  defaults: AppearancePreferences,
): AppearancePreferences {
  const validTheme = (value: unknown, mode: AppearanceThemeMode): value is KodexColorSchemeId =>
    typeof value === "string" && Object.hasOwn(modes, value) && modes[value] === mode;
  if (stored !== null) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const value = parsed as Record<string, unknown>;
        return {
          mode: value.mode === "light" || value.mode === "dark" ? value.mode : "auto",
          lightThemeId: validTheme(value.lightThemeId, "light") ? value.lightThemeId : defaults.lightThemeId,
          darkThemeId: validTheme(value.darkThemeId, "dark") ? value.darkThemeId : defaults.darkThemeId,
        };
      }
    } catch {
      // Invalid preferences fall back to the previous explicit choice, if available.
    }
  }
  if (validTheme(legacy, "light")) return { ...defaults, mode: "light", lightThemeId: legacy };
  if (validTheme(legacy, "dark")) return { ...defaults, mode: "dark", darkThemeId: legacy };
  return { ...defaults };
}

export function resolveAppearanceScheme(preferences: AppearancePreferences, systemDark: boolean): KodexColorSchemeId {
  const dark = preferences.mode === "dark" || (preferences.mode === "auto" && systemDark);
  return dark ? preferences.darkThemeId : preferences.lightThemeId;
}
