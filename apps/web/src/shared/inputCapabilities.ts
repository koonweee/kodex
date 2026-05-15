import { useEffect, useState } from "react";

export type InputCapabilities = {
  hasCoarsePointer: boolean;
  hasFineHover: boolean;
  hasTouchInput: boolean;
};

const INPUT_CAPABILITY_QUERIES = [
  "(any-pointer: coarse)",
  "(pointer: coarse)",
  "(hover: hover) and (pointer: fine)",
] as const;

export function readInputCapabilities(): InputCapabilities {
  const hasMaxTouchPoints = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
  const hasCoarsePointer =
    mediaQueryMatches("(any-pointer: coarse)") || mediaQueryMatches("(pointer: coarse)");
  const hasFineHover = mediaQueryMatches("(hover: hover) and (pointer: fine)");
  return {
    hasCoarsePointer,
    hasFineHover,
    hasTouchInput: hasMaxTouchPoints || hasCoarsePointer,
  };
}

export function isTouchInputDevice() {
  return readInputCapabilities().hasTouchInput;
}

export function useInputCapabilities(): InputCapabilities {
  const [capabilities, setCapabilities] = useState(readInputCapabilities);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQueries = INPUT_CAPABILITY_QUERIES.map((query) => window.matchMedia(query));
    const updateCapabilities = () => setCapabilities(readInputCapabilities());

    updateCapabilities();
    for (const mediaQuery of mediaQueries) {
      addMediaQueryListener(mediaQuery, updateCapabilities);
    }
    return () => {
      for (const mediaQuery of mediaQueries) {
        removeMediaQueryListener(mediaQuery, updateCapabilities);
      }
    };
  }, []);

  return capabilities;
}

function mediaQueryMatches(query: string) {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

function addMediaQueryListener(mediaQuery: MediaQueryList, listener: () => void) {
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", listener);
    return;
  }
  mediaQuery.addListener(listener);
}

function removeMediaQueryListener(mediaQuery: MediaQueryList, listener: () => void) {
  if (typeof mediaQuery.removeEventListener === "function") {
    mediaQuery.removeEventListener("change", listener);
    return;
  }
  mediaQuery.removeListener(listener);
}
