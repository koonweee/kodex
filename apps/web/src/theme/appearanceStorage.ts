import { KODEX_COLOR_SCHEMES, KODEX_COLOR_SCHEME_STORAGE_KEY } from "../themeRegistry";
import {
  APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE_PREFERENCES, parseAppearancePreferences,
  type AppearancePreferences,
} from "./appearancePreferences";

export { APPEARANCE_STORAGE_KEY } from "./appearancePreferences";
export const APPEARANCE_CHANGE_EVENT = "kodex-appearance-change";
const modes = Object.fromEntries(KODEX_COLOR_SCHEMES.map((scheme) => [scheme.id, scheme.mode]));

// A failed save must remain visible to panes mounted after the change event.
// A changed storage snapshot or external storage event supersedes this fallback.
let unsavedPreferences: AppearancePreferences | null = null;
let lastStored: string | null = null;
let lastLegacy: string | null = null;

export function readStoredAppearancePreferences(ignoreUnsaved = false): AppearancePreferences {
  if (ignoreUnsaved) unsavedPreferences = null;
  try {
    if (typeof window === "undefined") return { ...DEFAULT_APPEARANCE_PREFERENCES };
    const stored = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    const legacy = window.localStorage.getItem(KODEX_COLOR_SCHEME_STORAGE_KEY);
    if (unsavedPreferences && stored === lastStored && legacy === lastLegacy) return unsavedPreferences;
    unsavedPreferences = null;
    lastStored = stored;
    lastLegacy = legacy;
    return parseAppearancePreferences(stored, legacy, modes, DEFAULT_APPEARANCE_PREFERENCES);
  } catch {
    return unsavedPreferences ?? { ...DEFAULT_APPEARANCE_PREFERENCES };
  }
}

export function writeStoredAppearancePreferences(preferences: AppearancePreferences, notify = true) {
  if (typeof window === "undefined") return;
  try {
    const stored = JSON.stringify(preferences);
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, stored);
    window.localStorage.removeItem(KODEX_COLOR_SCHEME_STORAGE_KEY);
    lastStored = stored;
    lastLegacy = null;
    unsavedPreferences = null;
  } catch {
    unsavedPreferences = preferences;
    // In-memory preferences and late consumers still work without persistence.
  }
  if (notify) window.dispatchEvent(new CustomEvent<AppearancePreferences>(APPEARANCE_CHANGE_EVENT, { detail: preferences }));
}

export function systemPrefersDark(): boolean {
  try { return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches; }
  catch { return false; }
}
