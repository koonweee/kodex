import { useLayoutEffect, useState } from "react";

export type ComposerKeyboardViewport = {
  inlineKeyboardInset: number;
  inlineViewportOffsetTop: number;
  keyboardInset: number;
  viewportOffsetTop: number;
  viewportHeight: number;
};

export function useComposerKeyboardViewport(enabled = true, owner?: HTMLElement | null): ComposerKeyboardViewport {
  const [viewport, setViewport] = useState(() => readViewport(owner));

  useLayoutEffect(() => {
    if (!enabled) return;
    const visualViewport = window.visualViewport;

    function updateViewport() {
      const next = readViewport(owner);
      setViewport(current => current.inlineKeyboardInset === next.inlineKeyboardInset &&
        current.inlineViewportOffsetTop === next.inlineViewportOffsetTop &&
        current.keyboardInset === next.keyboardInset &&
        current.viewportHeight === next.viewportHeight && current.viewportOffsetTop === next.viewportOffsetTop ? current : next);
    }

    updateViewport();
    window.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("scroll", updateViewport);
    const pane = owner?.closest(".kodex-thread-pane");
    const observer = pane && typeof ResizeObserver !== "undefined" ? new ResizeObserver(updateViewport) : null;
    if (pane) observer?.observe(pane);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, [enabled, owner]);

  return viewport;
}

function readViewport(owner?: HTMLElement | null): ComposerKeyboardViewport {
  const layoutHeight = window.innerHeight || 0;
  const visualViewport = window.visualViewport;
  const viewportHeight = Math.round(visualViewport?.height ?? layoutHeight);
  const viewportOffsetTop = Math.max(0, Math.round(visualViewport?.offsetTop ?? 0));
  const keyboardInset = Math.max(0, Math.round(layoutHeight - viewportHeight - viewportOffsetTop));
  const paneBounds = owner?.closest(".kodex-thread-pane")?.getBoundingClientRect();
  const inlineViewportOffsetTop = paneBounds
    ? Math.max(0, Math.min(Math.round(paneBounds.height), viewportOffsetTop - Math.round(paneBounds.top)))
    : viewportOffsetTop;
  const inlineKeyboardInset = paneBounds
    ? Math.max(0, Math.min(Math.round(paneBounds.height), Math.round(paneBounds.bottom - viewportOffsetTop - viewportHeight)))
    : keyboardInset;
  return { inlineKeyboardInset, inlineViewportOffsetTop, keyboardInset, viewportHeight, viewportOffsetTop };
}
