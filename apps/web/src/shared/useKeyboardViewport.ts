import { useLayoutEffect, useState } from "react";

type KeyboardViewport = {
  inlineKeyboardInset: number;
  inlineViewportOffsetTop: number;
  keyboardInset: number;
  viewportOffsetTop: number;
  viewportHeight: number;
};

export function useKeyboardViewport(enabled = true, pane?: Element | null): KeyboardViewport {
  const [viewport, setViewport] = useState(() => readViewport(pane));

  useLayoutEffect(() => {
    if (!enabled) return;
    const visualViewport = window.visualViewport;

    function updateViewport() {
      const next = readViewport(pane);
      setViewport(current => current.inlineKeyboardInset === next.inlineKeyboardInset &&
        current.inlineViewportOffsetTop === next.inlineViewportOffsetTop &&
        current.keyboardInset === next.keyboardInset &&
        current.viewportHeight === next.viewportHeight && current.viewportOffsetTop === next.viewportOffsetTop ? current : next);
    }

    updateViewport();
    window.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("scroll", updateViewport);
    const observer = pane && typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateViewport) : null;
    if (pane) observer?.observe(pane);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, [enabled, pane]);

  return viewport;
}

function readViewport(pane?: Element | null): KeyboardViewport {
  const layoutHeight = window.innerHeight || 0;
  const visualViewport = window.visualViewport;
  const viewportHeight = Math.round(visualViewport?.height ?? layoutHeight);
  const viewportOffsetTop = Math.max(0, Math.round(visualViewport?.offsetTop ?? 0));
  const keyboardInset = Math.max(0, Math.round(layoutHeight - viewportHeight - viewportOffsetTop));
  const paneBounds = pane?.getBoundingClientRect();
  const inlineViewportOffsetTop = paneBounds
    ? Math.max(0, Math.min(Math.round(paneBounds.height), viewportOffsetTop - Math.round(paneBounds.top)))
    : viewportOffsetTop;
  const inlineKeyboardInset = paneBounds
    ? Math.max(0, Math.min(Math.round(paneBounds.height), Math.round(paneBounds.bottom - viewportOffsetTop - viewportHeight)))
    : keyboardInset;
  return { inlineKeyboardInset, inlineViewportOffsetTop, keyboardInset, viewportHeight, viewportOffsetTop };
}
