import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

const SIDEBAR_MIN_WIDTH = 292;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_RESIZE_STEP = 24;

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function useSidebarResize() {
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_MIN_WIDTH);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarResizeStart = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    if (!isSidebarResizing) {
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      const start = sidebarResizeStart.current;
      if (!start) {
        return;
      }
      setSidebarWidth(clampSidebarWidth(start.width + event.clientX - start.x));
    }

    function finishResize() {
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
    sidebarResizeStart.current = { x: event.clientX, width: sidebarWidth };
    setIsSidebarResizing(true);
  }

  function handleSidebarResizeKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSidebarWidth((width) => clampSidebarWidth(width - SIDEBAR_RESIZE_STEP));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setSidebarWidth((width) => clampSidebarWidth(width + SIDEBAR_RESIZE_STEP));
    } else if (event.key === "Home") {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setSidebarWidth(SIDEBAR_MAX_WIDTH);
    }
  }

  return {
    handleSidebarResizeKeyDown,
    handleSidebarResizePointerDown,
    isSidebarResizing,
    sidebarWidth,
  };
}
