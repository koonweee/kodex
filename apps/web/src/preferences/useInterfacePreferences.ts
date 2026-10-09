import { useCallback, useEffect, useRef, useState } from "react";

export type InterfacePreferences = {
  fullscreenComposerOnTouch: boolean;
  autoUpdatePwa: boolean;
};

export const INTERFACE_PREFERENCES_STORAGE_KEY = "kodex-interface";
export const DEFAULT_INTERFACE_PREFERENCES: InterfacePreferences = {
  fullscreenComposerOnTouch: true,
  autoUpdatePwa: false,
};

const INTERFACE_PREFERENCES_CHANGE_EVENT = "kodex-interface-preferences-change";
let unsavedPreferences: InterfacePreferences | null = null;
let lastStored: string | null = null;

function parseInterfacePreferences(stored: string | null): InterfacePreferences {
  if (!stored) return { ...DEFAULT_INTERFACE_PREFERENCES };
  try {
    const value = JSON.parse(stored) as Partial<InterfacePreferences> | null;
    return {
      autoUpdatePwa: typeof value?.autoUpdatePwa === "boolean" ? value.autoUpdatePwa : DEFAULT_INTERFACE_PREFERENCES.autoUpdatePwa,
      fullscreenComposerOnTouch:
        typeof value?.fullscreenComposerOnTouch === "boolean"
          ? value.fullscreenComposerOnTouch
          : DEFAULT_INTERFACE_PREFERENCES.fullscreenComposerOnTouch,
    };
  } catch {
    return { ...DEFAULT_INTERFACE_PREFERENCES };
  }
}

export function readStoredInterfacePreferences(ignoreUnsaved = false): InterfacePreferences {
  if (ignoreUnsaved) unsavedPreferences = null;
  try {
    if (typeof window === "undefined") return { ...DEFAULT_INTERFACE_PREFERENCES };
    const stored = window.localStorage.getItem(INTERFACE_PREFERENCES_STORAGE_KEY);
    if (unsavedPreferences && stored === lastStored) return unsavedPreferences;
    unsavedPreferences = null;
    lastStored = stored;
    return parseInterfacePreferences(stored);
  } catch {
    return unsavedPreferences ?? { ...DEFAULT_INTERFACE_PREFERENCES };
  }
}

function writeStoredInterfacePreferences(preferences: InterfacePreferences, notify = true) {
  if (typeof window === "undefined") return;
  try {
    const stored = JSON.stringify(preferences);
    window.localStorage.setItem(INTERFACE_PREFERENCES_STORAGE_KEY, stored);
    lastStored = stored;
    unsavedPreferences = null;
  } catch {
    unsavedPreferences = preferences;
  }
  if (notify) {
    window.dispatchEvent(new CustomEvent<InterfacePreferences>(INTERFACE_PREFERENCES_CHANGE_EVENT, {
      detail: preferences,
    }));
  }
}

/** Device-local interface choices, synchronized across consumers and browser tabs. */
export function useInterfacePreferences() {
  const [preferences, setPreferences] = useState(readStoredInterfacePreferences);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;

  useEffect(() => {
    writeStoredInterfacePreferences(preferencesRef.current, false);
    const receive = (next: InterfacePreferences) => {
      preferencesRef.current = next;
      setPreferences(next);
    };
    const onSameTabChange = (event: Event) => {
      receive((event as CustomEvent<InterfacePreferences>).detail);
    };
    const onStorage = (event: StorageEvent) => {
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      if (event.key === null || event.key === INTERFACE_PREFERENCES_STORAGE_KEY) {
        receive(readStoredInterfacePreferences(true));
      }
    };
    window.addEventListener(INTERFACE_PREFERENCES_CHANGE_EVENT, onSameTabChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(INTERFACE_PREFERENCES_CHANGE_EVENT, onSameTabChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const updatePreferences = useCallback((changes: Partial<InterfacePreferences>) => {
    const next = { ...preferencesRef.current, ...changes };
    preferencesRef.current = next;
    setPreferences(next);
    writeStoredInterfacePreferences(next);
  }, []);

  const setFullscreenComposerOnTouch = useCallback((value: boolean) => updatePreferences({ fullscreenComposerOnTouch: value }), [updatePreferences]);
  const setAutoUpdatePwa = useCallback((value: boolean) => updatePreferences({ autoUpdatePwa: value }), [updatePreferences]);
  return { preferences, setFullscreenComposerOnTouch, setAutoUpdatePwa };
}
