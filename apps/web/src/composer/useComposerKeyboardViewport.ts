import { useEffect, useState } from "react";

export type ComposerKeyboardViewport = {
  keyboardInset: number;
  viewportHeight: number;
};

export function useComposerKeyboardViewport(): ComposerKeyboardViewport {
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    const visualViewport = window.visualViewport;

    function updateViewport() {
      setViewport(readViewport());
    }

    window.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("resize", updateViewport);
    visualViewport?.addEventListener("scroll", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("resize", updateViewport);
      visualViewport?.removeEventListener("scroll", updateViewport);
    };
  }, []);

  return viewport;
}

function readViewport(): ComposerKeyboardViewport {
  const layoutHeight = window.innerHeight || 0;
  const visualViewport = window.visualViewport;
  const viewportHeight = Math.round(visualViewport?.height ?? layoutHeight);
  const keyboardInset = Math.max(0, Math.round(layoutHeight - viewportHeight - (visualViewport?.offsetTop ?? 0)));
  return { keyboardInset, viewportHeight };
}
