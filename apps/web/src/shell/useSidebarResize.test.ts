import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useSidebarResize } from "./useSidebarResize";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "kodex.sidebar.collapsed";

describe("useSidebarResize", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("hydrates collapsed state from localStorage and keeps a fixed width", () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");

    const { result } = renderHook(() => useSidebarResize());

    expect(result.current.sidebarWidth).toBe(292);
    expect(result.current.sidebarCollapsed).toBe(true);
  });

  it("persists explicit collapse and expand state to localStorage", () => {
    const { result } = renderHook(() => useSidebarResize());

    act(() => {
      result.current.handleSidebarCollapseClick();
    });

    expect(result.current.sidebarCollapsed).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");

    act(() => {
      result.current.handleSidebarExpandClick();
    });

    expect(result.current.sidebarCollapsed).toBe(false);
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("false");
  });

  it("falls back to defaults for invalid stored values", () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "yes");

    const { result } = renderHook(() => useSidebarResize());

    expect(result.current.sidebarWidth).toBe(292);
    expect(result.current.sidebarCollapsed).toBe(false);
  });
});
