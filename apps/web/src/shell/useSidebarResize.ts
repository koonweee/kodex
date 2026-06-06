import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

const SIDEBAR_MIN_WIDTH = 292;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_RESIZE_STEP = 24;
const SIDEBAR_WIDTH_STORAGE_KEY = "kodex.sidebar.width";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "kodex.sidebar.collapsed";

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function readStoredSidebarWidth(): number {
  if (typeof window === "undefined") {
    return SIDEBAR_MIN_WIDTH;
  }
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const parsed = stored === null ? NaN : Number(stored);
    return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_MIN_WIDTH;
  } catch {
    return SIDEBAR_MIN_WIDTH;
  }
}

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

function writeStoredSidebarState({ collapsed, width }: { collapsed: boolean; width: number }) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)));
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // Storage availability should not block the resize interaction.
  }
}

export function useSidebarResize() {
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readStoredSidebarCollapsed);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarState = useRef<{ collapsed: boolean; width: number } | null>(null);
  const sidebarResizeStart = useRef<{ collapsed: boolean; x: number; width: number } | null>(null);

  if (sidebarState.current === null) {
    sidebarState.current = { collapsed: sidebarCollapsed, width: sidebarWidth };
  }

  function applySidebarState(next: { collapsed: boolean; width: number }, options: { persist?: boolean } = {}) {
    const normalized = { collapsed: next.collapsed, width: clampSidebarWidth(next.width) };
    sidebarState.current = normalized;
    setSidebarCollapsed(normalized.collapsed);
    setSidebarWidth(normalized.width);
    if (options.persist) {
      writeStoredSidebarState(normalized);
    }
  }

  useEffect(() => {
    if (!isSidebarResizing) {
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      const start = sidebarResizeStart.current;
      if (!start) {
        return;
      }
      const deltaX = event.clientX - start.x;
      if (start.collapsed) {
        if (deltaX <= 0) {
          return;
        }
        applySidebarState({ collapsed: false, width: SIDEBAR_MIN_WIDTH + deltaX });
        return;
      }

      const nextWidth = start.width + deltaX;
      if (nextWidth < SIDEBAR_MIN_WIDTH) {
        applySidebarState({ collapsed: true, width: start.width });
        return;
      }
      applySidebarState({ collapsed: false, width: nextWidth });
    }

    function finishResize() {
      if (sidebarState.current) {
        writeStoredSidebarState(sidebarState.current);
      }
      sidebarResizeStart.current = null;
      setIsSidebarResizing(false);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [isSidebarResizing]);

  function handleSidebarResizePointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    sidebarResizeStart.current = { collapsed: sidebarCollapsed, x: event.clientX, width: sidebarWidth };
    setIsSidebarResizing(true);
  }

  function handleSidebarExpandClick() {
    if (!sidebarCollapsed) {
      return;
    }
    applySidebarState({ collapsed: false, width: SIDEBAR_MIN_WIDTH }, { persist: true });
  }

  function handleSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (sidebarCollapsed) {
        return;
      }
      const current = sidebarState.current ?? { collapsed: sidebarCollapsed, width: sidebarWidth };
      const nextWidth = current.width - SIDEBAR_RESIZE_STEP;
      applySidebarState(
        nextWidth < SIDEBAR_MIN_WIDTH
          ? { collapsed: true, width: current.width }
          : { collapsed: false, width: nextWidth },
        { persist: true },
      );
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (sidebarCollapsed) {
        applySidebarState({ collapsed: false, width: SIDEBAR_MIN_WIDTH }, { persist: true });
        return;
      }
      const current = sidebarState.current ?? { collapsed: sidebarCollapsed, width: sidebarWidth };
      applySidebarState({ collapsed: false, width: current.width + SIDEBAR_RESIZE_STEP }, { persist: true });
    } else if (event.key === "Home") {
      event.preventDefault();
      const current = sidebarState.current ?? { collapsed: sidebarCollapsed, width: sidebarWidth };
      applySidebarState({ collapsed: true, width: current.width }, { persist: true });
    } else if (event.key === "End") {
      event.preventDefault();
      applySidebarState({ collapsed: false, width: SIDEBAR_MAX_WIDTH }, { persist: true });
    }
  }

  return {
    handleSidebarResizeKeyDown,
    handleSidebarResizePointerDown,
    handleSidebarExpandClick,
    isSidebarResizing,
    sidebarCollapsed,
    sidebarWidth,
  };
}
