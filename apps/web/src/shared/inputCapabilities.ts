import { useEffect, useState } from "react";

export type InputCapabilities = {
  hasAnyCoarsePointer: boolean;
  hasPrimaryFineHover: boolean;
  hasTouchInput: boolean;
};

export const ANY_COARSE_POINTER_QUERY = "(any-pointer: coarse)";
export const COARSE_POINTER_QUERY = "(pointer: coarse)";
export const FINE_HOVER_QUERY = "(hover: hover) and (pointer: fine)";

const INPUT_CAPABILITY_QUERIES = [
  ANY_COARSE_POINTER_QUERY,
  COARSE_POINTER_QUERY,
  FINE_HOVER_QUERY,
] as const;

export function readInputCapabilities(): InputCapabilities {
  const hasMaxTouchPoints = typeof navigator !== "undefined" && navigator.maxTouchPoints > 0;
  const hasAnyCoarsePointer =
    mediaQueryMatches(ANY_COARSE_POINTER_QUERY) || mediaQueryMatches(COARSE_POINTER_QUERY);
  const hasPrimaryFineHover = mediaQueryMatches(FINE_HOVER_QUERY);
  return {
    hasAnyCoarsePointer,
    hasPrimaryFineHover,
    hasTouchInput: hasMaxTouchPoints || hasAnyCoarsePointer,
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
