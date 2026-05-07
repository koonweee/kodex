import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useComposerKeyboardViewport } from "./useComposerKeyboardViewport";

describe("useComposerKeyboardViewport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the visual viewport height and keyboard inset", () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", {
      addEventListener: (event: string, listener: EventListener) => listeners.set(event, listener),
      height: 520,
      offsetTop: 12,
      removeEventListener: (event: string) => listeners.delete(event),
    });

    const { result } = renderHook(() => useComposerKeyboardViewport());

    expect(result.current).toEqual({ keyboardInset: 268, viewportHeight: 520 });

    act(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 600 });
      Object.defineProperty(window.visualViewport, "offsetTop", { configurable: true, value: 0 });
      listeners.get("resize")?.(new Event("resize"));
    });

    expect(result.current).toEqual({ keyboardInset: 200, viewportHeight: 600 });
  });
});
