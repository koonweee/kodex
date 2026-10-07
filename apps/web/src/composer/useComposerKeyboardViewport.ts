import { useLayoutEffect, useState } from "react";

export type ComposerKeyboardViewport = {
  keyboardInset: number;
  viewportOffsetTop: number;
  viewportHeight: number;
};

export function useComposerKeyboardViewport(enabled = true): ComposerKeyboardViewport {
  const [viewport, setViewport] = useState(readViewport);

  useLayoutEffect(() => {
    if (!enabled) return;
    const visualViewport = window.visualViewport;

    function updateViewport() {
      const next = readViewport();
      setViewport(current => current.keyboardInset === next.keyboardInset &&
        current.viewportHeight === next.viewportHeight && current.viewportOffsetTop === next.viewportOffsetTop ? current : next);
    }

    updateViewport();
    window.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, [enabled]);

  return viewport;
}

function readViewport(): ComposerKeyboardViewport {
  const layoutHeight = window.innerHeight || 0;
  const visualViewport = window.visualViewport;
  const viewportHeight = Math.round(visualViewport?.height ?? layoutHeight);
  const viewportOffsetTop = Math.max(0, Math.round(visualViewport?.offsetTop ?? 0));
  const keyboardInset = Math.max(0, Math.round(layoutHeight - viewportHeight - viewportOffsetTop));
  return { keyboardInset, viewportHeight, viewportOffsetTop };
}
