import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isTouchInputDevice, readInputCapabilities, useInputCapabilities } from "./inputCapabilities";

describe("input capabilities", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats maxTouchPoints as touch input", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 1 });
    vi.stubGlobal("matchMedia", mediaMatcher({}));

    expect(readInputCapabilities()).toEqual({
      hasCoarsePointer: false,
      hasFineHover: false,
      hasTouchInput: true,
    });
    expect(isTouchInputDevice()).toBe(true);
  });

  it("reports coarse pointer and fine hover media capabilities", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 0 });
    vi.stubGlobal(
      "matchMedia",
      mediaMatcher({
        "(any-pointer: coarse)": true,
        "(hover: hover) and (pointer: fine)": true,
      }),
    );

    expect(readInputCapabilities()).toEqual({
      hasCoarsePointer: true,
      hasFineHover: true,
      hasTouchInput: true,
    });
  });

  it("updates when input media queries change", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 0 });
    const matcher = mutableMediaMatcher({
      "(any-pointer: coarse)": false,
      "(pointer: coarse)": false,
      "(hover: hover) and (pointer: fine)": true,
    });
    vi.stubGlobal("matchMedia", matcher.matchMedia);

    const { result } = renderHook(() => useInputCapabilities());

    expect(result.current).toEqual({
      hasCoarsePointer: false,
      hasFineHover: true,
      hasTouchInput: false,
    });

    act(() => {
      matcher.setMatches("(any-pointer: coarse)", true);
    });

    expect(result.current).toEqual({
      hasCoarsePointer: true,
      hasFineHover: true,
      hasTouchInput: true,
    });
  });

  it("falls back to no touch input when media APIs are unavailable", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 0 });
    vi.stubGlobal("matchMedia", undefined);

    expect(readInputCapabilities()).toEqual({
      hasCoarsePointer: false,
      hasFineHover: false,
      hasTouchInput: false,
    });
  });
});

function mediaMatcher(matchesByQuery: Record<string, boolean>) {
  return (query: string): MediaQueryList => mediaQueryList(query, Boolean(matchesByQuery[query]));
}

function mutableMediaMatcher(initialMatches: Record<string, boolean>) {
  const listenersByQuery = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const matchesByQuery = new Map(Object.entries(initialMatches));

  return {
    matchMedia: (query: string): MediaQueryList =>
      mediaQueryList(query, Boolean(matchesByQuery.get(query)), (listener) => {
        const listeners = listenersByQuery.get(query) ?? new Set();
        listeners.add(listener);
        listenersByQuery.set(query, listeners);
      }),
    setMatches: (query: string, matches: boolean) => {
      matchesByQuery.set(query, matches);
      for (const listener of listenersByQuery.get(query) ?? []) {
        dispatchMediaQueryChange(listener);
      }
    },
  };
}

function mediaQueryList(
  query: string,
  matches: boolean,
  onAddListener?: (listener: EventListenerOrEventListenerObject) => void,
): MediaQueryList {
  return {
    matches,
    media: query,
    onchange: null,
    addEventListener: (_event: string, listener: EventListenerOrEventListenerObject) => onAddListener?.(listener),
    removeEventListener: () => undefined,
    addListener: (listener: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null) => {
      if (listener) {
        onAddListener?.(listener as EventListener);
      }
    },
    removeListener: () => undefined,
    dispatchEvent: () => false,
  };
}

function dispatchMediaQueryChange(listener: EventListenerOrEventListenerObject) {
  const event = new Event("change");
  if (typeof listener === "function") {
    listener(event);
    return;
  }
  listener.handleEvent(event);
}
