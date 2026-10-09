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

    expect(result.current).toEqual({ inlineKeyboardInset: 268, inlineViewportOffsetTop: 12,
      keyboardInset: 268, viewportHeight: 520, viewportOffsetTop: 12 });

    act(() => {
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 600 });
      Object.defineProperty(window.visualViewport, "offsetTop", { configurable: true, value: 0 });
      listeners.get("resize")?.(new Event("resize"));
    });

    expect(result.current).toEqual({ inlineKeyboardInset: 200, inlineViewportOffsetTop: 0,
      keyboardInset: 200, viewportHeight: 600, viewportOffsetTop: 0 });
  });

  it("only reserves the part of an owning pane overlapped by the keyboard", () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("visualViewport", {
      addEventListener: (event: string, listener: EventListener) => listeners.set(event, listener),
      height: 500,
      offsetTop: 0,
      removeEventListener: (event: string) => listeners.delete(event),
    });
    const pane = document.createElement("section");
    pane.className = "kodex-thread-pane";
    const composer = document.createElement("div");
    pane.append(composer);
    document.body.append(pane);
    let paneBottom = 420;
    let paneTop = 0;
    vi.spyOn(pane, "getBoundingClientRect").mockImplementation(() => ({
      bottom: paneBottom, height: paneBottom - paneTop, left: 0, right: 390, top: paneTop, width: 390, x: 0, y: paneTop,
      toJSON: () => ({}),
    }));

    const { result } = renderHook(() => useComposerKeyboardViewport(true, composer));
    expect(result.current).toMatchObject({ inlineKeyboardInset: 0, inlineViewportOffsetTop: 0, keyboardInset: 300 });

    act(() => {
      paneBottom = 620;
      listeners.get("resize")?.(new Event("resize"));
    });
    expect(result.current).toMatchObject({ inlineKeyboardInset: 120, keyboardInset: 300 });

    act(() => {
      paneTop = 40;
      Object.defineProperty(window.visualViewport, "height", { configurable: true, value: 424 });
      Object.defineProperty(window.visualViewport, "offsetTop", { configurable: true, value: 120 });
      listeners.get("scroll")?.(new Event("scroll"));
    });
    expect(result.current).toMatchObject({ inlineKeyboardInset: 76, inlineViewportOffsetTop: 80, keyboardInset: 256 });
    pane.remove();
  });
});
