import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildKodexColorSchemeBootstrapScript } from "../themeRegistry";
import { readStoredAppearancePreferences, APPEARANCE_STORAGE_KEY } from "./appearanceStorage";
import { useAppearancePreferences } from "./useAppearancePreferences";

let dark = false;
let listeners: Set<(event: MediaQueryListEvent) => void>;
function changeSystemTheme(matches: boolean) {
  dark = matches;
  act(() => listeners.forEach((listener) => listener({ matches } as MediaQueryListEvent)));
}

beforeEach(() => {
  window.localStorage.clear();
  dark = false;
  readStoredAppearancePreferences(true);
  listeners = new Set();
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({
    get matches() { return dark; }, media,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
  })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); window.localStorage.clear(); });

describe("appearance preferences", () => {
  it("defaults to Auto and follows live system changes with independently selected themes", () => {
    const { result } = renderHook(() => useAppearancePreferences());
    expect(result.current.preferences).toEqual({ mode: "auto", lightThemeId: "paper-light", darkThemeId: "oled-black" });
    expect(result.current.resolvedSchemeId).toBe("paper-light");
    act(() => result.current.setTheme("dracula"));
    expect(result.current.preferences.mode).toBe("auto");
    expect(result.current.resolvedSchemeId).toBe("paper-light");
    changeSystemTheme(true);
    expect(result.current.resolvedSchemeId).toBe("dracula");
    act(() => result.current.setMode("light"));
    changeSystemTheme(false); changeSystemTheme(true);
    expect(result.current.resolvedSchemeId).toBe("paper-light");
    act(() => result.current.setMode("dark"));
    expect(result.current.resolvedSchemeId).toBe("dracula");
    expect(readStoredAppearancePreferences()).toEqual(result.current.preferences);
  });

  it("migrates explicit legacy choices and persists them without changing their mode", () => {
    window.localStorage.setItem("kodex-color-scheme", "monokai");
    const first = renderHook(() => useAppearancePreferences());
    expect(first.result.current.preferences).toEqual({ mode: "dark", lightThemeId: "paper-light", darkThemeId: "monokai" });
    changeSystemTheme(false);
    expect(first.result.current.resolvedSchemeId).toBe("monokai");
    first.unmount();
    expect(JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toEqual({ mode: "dark", lightThemeId: "paper-light", darkThemeId: "monokai" });
    window.localStorage.clear();
    window.localStorage.setItem("kodex-color-scheme", "paper-light");
    expect(readStoredAppearancePreferences().mode).toBe("light");
  });

  it("rejects unknown and wrong-mode theme slots while preserving valid preferences", () => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ mode: "dark", lightThemeId: "dracula", darkThemeId: "paper-light" }));
    expect(readStoredAppearancePreferences()).toEqual({ mode: "dark", lightThemeId: "paper-light", darkThemeId: "oled-black" });
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, "broken JSON");
    expect(readStoredAppearancePreferences().mode).toBe("auto");
  });

  it("converges from another tab's saved preferences and resets after storage is cleared", () => {
    const { result } = renderHook(() => useAppearancePreferences());
    const next = { mode: "dark", lightThemeId: "paper-light", darkThemeId: "monokai" };
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: APPEARANCE_STORAGE_KEY, newValue: JSON.stringify(next) })));
    expect(result.current.preferences).toEqual(next);
    expect(result.current.resolvedSchemeId).toBe("monokai");
    window.localStorage.clear();
    window.localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(result.current.preferences.mode).toBe("auto");
    expect(result.current.resolvedSchemeId).toBe("paper-light");
  });

  it("synchronizes same-tab consumers and preserves both slots after remount", () => {
    const first = renderHook(() => useAppearancePreferences());
    const second = renderHook(() => useAppearancePreferences());
    act(() => first.result.current.setTheme("dracula"));
    expect(second.result.current.preferences.darkThemeId).toBe("dracula");
    act(() => second.result.current.setMode("dark"));
    expect(first.result.current.resolvedSchemeId).toBe("dracula");
    first.unmount(); second.unmount();
    const reloaded = renderHook(() => useAppearancePreferences());
    expect(reloaded.result.current.preferences).toEqual({ mode: "dark", lightThemeId: "paper-light", darkThemeId: "dracula" });
    expect(reloaded.result.current.resolvedSchemeId).toBe("dracula");
  });

  it.each(["getter", "write"])("initializes late consumers from unsaved choices when storage %s fails", (failure) => {
    if (failure === "getter") vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    else vi.spyOn(Object.getPrototypeOf(window.localStorage), "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    const first = renderHook(() => useAppearancePreferences());
    act(() => first.result.current.selectTheme("dracula"));
    const late = renderHook(() => useAppearancePreferences());
    expect(late.result.current.preferences).toEqual(first.result.current.preferences);
    expect(late.result.current.resolvedSchemeId).toBe("dracula");
    first.unmount(); late.unmount();
    const remounted = renderHook(() => useAppearancePreferences());
    expect(remounted.result.current.resolvedSchemeId).toBe("dracula");
  });

  it("accepts an external storage clear after an in-memory-only choice", () => {
    vi.spyOn(Object.getPrototypeOf(window.localStorage), "setItem").mockImplementation(() => { throw new Error("quota exceeded"); });
    const { result } = renderHook(() => useAppearancePreferences());
    act(() => result.current.selectTheme("dracula"));
    expect(result.current.resolvedSchemeId).toBe("dracula");
    window.localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(result.current.preferences.mode).toBe("auto");
    expect(result.current.resolvedSchemeId).toBe("paper-light");
  });

  it("removes system listeners on unmount", () => {
    const mounted = renderHook(() => useAppearancePreferences());
    expect(listeners.size).toBe(1);
    mounted.unmount();
    expect(listeners.size).toBe(0);
  });

  it("keeps choices live when accessing localStorage throws", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    const { result } = renderHook(() => useAppearancePreferences());
    act(() => result.current.setTheme("dracula"));
    changeSystemTheme(true);
    expect(result.current.resolvedSchemeId).toBe("dracula");
    act(() => result.current.selectTheme("paper-light"));
    expect(result.current.preferences.mode).toBe("light");
    expect(result.current.resolvedSchemeId).toBe("paper-light");
  });

  it.each([false, true])("bootstraps the same default and stored appearance before React (dark=%s)", (matches) => {
    dark = matches;
    new Function(buildKodexColorSchemeBootstrapScript())();
    expect(document.documentElement.getAttribute("data-kodex-color-scheme")).toBe(matches ? "oled-black" : "paper-light");
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ mode: "auto", lightThemeId: "paper-light", darkThemeId: "dracula" }));
    new Function(buildKodexColorSchemeBootstrapScript())();
    expect(document.documentElement.getAttribute("data-kodex-color-scheme")).toBe(matches ? "dracula" : "paper-light");
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ mode: "light", lightThemeId: "paper-light", darkThemeId: "dracula" }));
    new Function(buildKodexColorSchemeBootstrapScript())();
    expect(document.documentElement.getAttribute("data-mantine-color-scheme")).toBe("light");
  });
  it("keeps bootstrap and runtime in agreement for a legacy choice and unavailable storage", () => {
    window.localStorage.setItem("kodex-color-scheme", "monokai");
    new Function(buildKodexColorSchemeBootstrapScript())();
    expect(document.documentElement.getAttribute("data-kodex-color-scheme")).toBe("monokai");
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    dark = true;
    new Function(buildKodexColorSchemeBootstrapScript())();
    expect(document.documentElement.getAttribute("data-kodex-color-scheme")).toBe("oled-black");
    const { result } = renderHook(() => useAppearancePreferences());
    expect(result.current.resolvedSchemeId).toBe("oled-black");
  });

});
