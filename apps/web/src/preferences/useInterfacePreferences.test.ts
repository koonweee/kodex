import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_INTERFACE_PREFERENCES,
  INTERFACE_PREFERENCES_STORAGE_KEY,
  readStoredInterfacePreferences,
  useInterfacePreferences,
} from "./useInterfacePreferences";

beforeEach(() => {
  window.localStorage.clear();
  readStoredInterfacePreferences(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  readStoredInterfacePreferences(true);
});

describe("interface preferences", () => {
  it("defaults fullscreen touch opening on and persists an explicit opt-out", () => {
    const { result, unmount } = renderHook(() => useInterfacePreferences());
    expect(result.current.preferences).toEqual(DEFAULT_INTERFACE_PREFERENCES);
    act(() => result.current.setFullscreenComposerOnTouch(false));
    expect(JSON.parse(window.localStorage.getItem(INTERFACE_PREFERENCES_STORAGE_KEY)!)).toEqual({
      fullscreenComposerOnTouch: false,
      autoUpdatePwa: false,
    });
    unmount();
    expect(renderHook(() => useInterfacePreferences()).result.current.preferences.fullscreenComposerOnTouch).toBe(false);
  });

  it("synchronizes same-tab consumers and external tab changes", () => {
    const first = renderHook(() => useInterfacePreferences());
    const second = renderHook(() => useInterfacePreferences());
    act(() => first.result.current.setFullscreenComposerOnTouch(false));
    expect(second.result.current.preferences.fullscreenComposerOnTouch).toBe(false);

    const stored = JSON.stringify({ fullscreenComposerOnTouch: true });
    window.localStorage.setItem(INTERFACE_PREFERENCES_STORAGE_KEY, stored);
    act(() => window.dispatchEvent(new StorageEvent("storage", {
      key: INTERFACE_PREFERENCES_STORAGE_KEY,
      newValue: stored,
    })));
    expect(first.result.current.preferences.fullscreenComposerOnTouch).toBe(true);
    expect(second.result.current.preferences.fullscreenComposerOnTouch).toBe(true);
  });

  it("persists auto updates without replacing the composer choice and converges across consumers", () => {
    const first = renderHook(() => useInterfacePreferences());
    const second = renderHook(() => useInterfacePreferences());
    act(() => first.result.current.setFullscreenComposerOnTouch(false));
    act(() => first.result.current.setAutoUpdatePwa(true));
    expect(second.result.current.preferences).toEqual({ fullscreenComposerOnTouch: false, autoUpdatePwa: true });
    first.unmount();
    expect(renderHook(() => useInterfacePreferences()).result.current.preferences.autoUpdatePwa).toBe(true);
    localStorage.setItem(INTERFACE_PREFERENCES_STORAGE_KEY, JSON.stringify({ fullscreenComposerOnTouch: false, autoUpdatePwa: false }));
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: INTERFACE_PREFERENCES_STORAGE_KEY })));
    expect(second.result.current.preferences.autoUpdatePwa).toBe(false);
  });

  it("returns to defaults when storage is cleared or malformed", () => {
    window.localStorage.setItem(INTERFACE_PREFERENCES_STORAGE_KEY, JSON.stringify({ fullscreenComposerOnTouch: false }));
    const { result } = renderHook(() => useInterfacePreferences());
    expect(result.current.preferences.fullscreenComposerOnTouch).toBe(false);
    window.localStorage.clear();
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(result.current.preferences.fullscreenComposerOnTouch).toBe(true);

    window.localStorage.setItem(INTERFACE_PREFERENCES_STORAGE_KEY, "not json");
    act(() => window.dispatchEvent(new StorageEvent("storage", { key: INTERFACE_PREFERENCES_STORAGE_KEY })));
    expect(result.current.preferences.fullscreenComposerOnTouch).toBe(true);
  });

  it("keeps an opt-out live when localStorage writes fail", () => {
    vi.spyOn(Object.getPrototypeOf(window.localStorage), "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    const first = renderHook(() => useInterfacePreferences());
    act(() => first.result.current.setFullscreenComposerOnTouch(false));
    const late = renderHook(() => useInterfacePreferences());
    expect(first.result.current.preferences.fullscreenComposerOnTouch).toBe(false);
    expect(late.result.current.preferences.fullscreenComposerOnTouch).toBe(false);
  });
});
