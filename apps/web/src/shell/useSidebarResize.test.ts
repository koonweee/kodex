import { act, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import { useSidebarResize } from "./useSidebarResize";

const SIDEBAR_WIDTH_STORAGE_KEY = "kodex.sidebar.width";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "kodex.sidebar.collapsed";

describe("useSidebarResize", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("hydrates width and collapsed state from localStorage", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "420");
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");

    const { result } = renderHook(() => useSidebarResize());

    expect(result.current.sidebarWidth).toBe(420);
    expect(result.current.sidebarCollapsed).toBe(true);
  });

  it("persists resize and collapse state to localStorage", () => {
    const { result } = renderHook(() => useSidebarResize());

    act(() => {
      result.current.handleSidebarResizePointerDown(pointerEvent(292));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 420 }));
    });
    expect(result.current.sidebarWidth).toBe(420);
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBeNull();

    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup"));
    });

    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("420");
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("false");

    act(() => {
      result.current.handleSidebarResizePointerDown(pointerEvent(420));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 260 }));
    });
    expect(result.current.sidebarCollapsed).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("false");

    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup"));
    });

    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");
  });

  it("falls back to defaults for invalid stored values", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "wide");
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "yes");

    const { result } = renderHook(() => useSidebarResize());

    expect(result.current.sidebarWidth).toBe(292);
    expect(result.current.sidebarCollapsed).toBe(false);
  });
});

function pointerEvent(clientX: number) {
  return {
    clientX,
    preventDefault: () => undefined,
  } as ReactPointerEvent<HTMLButtonElement>;
}
