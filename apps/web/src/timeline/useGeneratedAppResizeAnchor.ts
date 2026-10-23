import { useEffect } from "react";
import { captureTimelineScrollAnchor, restoreTimelineScrollAnchor, type TimelineScrollAnchor } from "./scrollAnchor";

export const GENERATED_APP_RESIZE_EVENT = "kodex:generated-app-resize";

// Virtuoso compensates upward scrolling, but an above-viewport iframe can also
// resize while the reader is stationary after scrolling down. Keep that reader's
// visible row through the following measurement frames. User input cancels it.
export function useGeneratedAppResizeAnchor(scroll: HTMLDivElement | null, isFollowingBottom: () => boolean) {
  useEffect(() => {
    if (!scroll) return;
    let anchor: TimelineScrollAnchor | null = null;
    let frame: number | null = null;
    let passes = 0;
    const cancel = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      anchor = null;
    };
    const restore = () => {
      frame = null;
      if (!anchor) return;
      restoreTimelineScrollAnchor(scroll, anchor);
      if (--passes > 0) frame = requestAnimationFrame(restore);
      else cancel();
    };
    const beforeResize = (event: Event) => {
      if (!(event.target instanceof HTMLIFrameElement)) return;
      const viewport = scroll.getBoundingClientRect();
      if (event.target.getBoundingClientRect().bottom > viewport.top || isFollowingBottom()) return;
      if (!anchor) {
        anchor = captureTimelineScrollAnchor(scroll);
        if (!anchor) return;
      }
      passes = 4;
      if (frame === null) frame = requestAnimationFrame(restore);
    };
    scroll.addEventListener(GENERATED_APP_RESIZE_EVENT, beforeResize);
    scroll.addEventListener("wheel", cancel, { passive: true });
    scroll.addEventListener("touchstart", cancel, { passive: true });
    scroll.addEventListener("pointerdown", cancel);
    document.addEventListener("keydown", cancel);
    return () => {
      cancel();
      scroll.removeEventListener(GENERATED_APP_RESIZE_EVENT, beforeResize);
      scroll.removeEventListener("wheel", cancel);
      scroll.removeEventListener("touchstart", cancel);
      scroll.removeEventListener("pointerdown", cancel);
      document.removeEventListener("keydown", cancel);
    };
  }, [scroll, isFollowingBottom]);
}
