import { useCallback, useEffect, useRef, useState } from "react";

import { getKodexColorSchemeDefinition, KODEX_COLOR_SCHEME_STORAGE_KEY, type KodexColorSchemeId } from "../themeRegistry";
import { resolveAppearanceScheme, type AppearanceMode, type AppearancePreferences } from "./appearancePreferences";
import {
  APPEARANCE_CHANGE_EVENT, APPEARANCE_STORAGE_KEY, readStoredAppearancePreferences,
  systemPrefersDark, writeStoredAppearancePreferences,
} from "./appearanceStorage";

/** Device-local visual preferences, shared by consumers in this tab and other tabs. */
export function useAppearancePreferences() {
  const [preferences, setPreferences] = useState(readStoredAppearancePreferences);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    writeStoredAppearancePreferences(preferencesRef.current, false);
    const receive = (next: AppearancePreferences) => {
      preferencesRef.current = next;
      setPreferences(next);
    };
    const onSameTabChange = (event: Event) => receive((event as CustomEvent<AppearancePreferences>).detail);
    const onStorage = (event: StorageEvent) => {
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch { return; }
      if (event.key === null || event.key === APPEARANCE_STORAGE_KEY || event.key === KODEX_COLOR_SCHEME_STORAGE_KEY) {
        receive(readStoredAppearancePreferences(true));
      }
    };
    window.addEventListener(APPEARANCE_CHANGE_EVENT, onSameTabChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGE_EVENT, onSameTabChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    try {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
      setSystemDark(media.matches);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    } catch {
      // Environments without system color preferences use the light Auto slot.
    }
  }, []);

  const save = useCallback((next: AppearancePreferences) => {
    preferencesRef.current = next;
    setPreferences(next);
    writeStoredAppearancePreferences(next);
  }, []);
  const setMode = useCallback((mode: AppearanceMode) => save({ ...preferencesRef.current, mode }), [save]);
  const setTheme = useCallback((id: KodexColorSchemeId) => {
    const scheme = getKodexColorSchemeDefinition(id);
    save({ ...preferencesRef.current, [scheme.mode === "light" ? "lightThemeId" : "darkThemeId"]: scheme.id });
  }, [save]);
  const selectTheme = useCallback((id: KodexColorSchemeId) => {
    const scheme = getKodexColorSchemeDefinition(id);
    save({ ...preferencesRef.current, mode: scheme.mode, [scheme.mode === "light" ? "lightThemeId" : "darkThemeId"]: scheme.id });
  }, [save]);
  return { preferences, resolvedSchemeId: resolveAppearanceScheme(preferences, systemDark), setMode, setTheme, selectTheme };
}
