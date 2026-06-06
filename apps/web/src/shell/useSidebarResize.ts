import { useState } from "react";

const SIDEBAR_MIN_WIDTH = 292;
const SIDEBAR_COLLAPSED_STORAGE_KEY = "kodex.sidebar.collapsed";

function readStoredSidebarCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeStoredSidebarCollapsed(collapsed: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // Storage availability should not block the collapse interaction.
  }
}

export function useSidebarResize() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readStoredSidebarCollapsed);

  function handleSidebarExpandClick() {
    if (!sidebarCollapsed) {
      return;
    }
    setSidebarCollapsed(false);
    writeStoredSidebarCollapsed(false);
  }

  function handleSidebarCollapseClick() {
    if (sidebarCollapsed) {
      return;
    }
    setSidebarCollapsed(true);
    writeStoredSidebarCollapsed(true);
  }

  return {
    handleSidebarCollapseClick,
    handleSidebarExpandClick,
    isSidebarResizing: false,
    sidebarCollapsed,
    sidebarWidth: SIDEBAR_MIN_WIDTH,
  };
}
