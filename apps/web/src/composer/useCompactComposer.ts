import { useLayoutEffect, useState, type RefObject } from "react";

// Observe the pane, not the composer itself: typing must not change the breakpoint.
export function useCompactComposer(textareaRef: RefObject<HTMLTextAreaElement | null>) {
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const pane = textareaRef.current?.closest(".kodex-thread-pane");
    if (!pane) return;
    const update = () => setCompact(pane.getBoundingClientRect().height < 600);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(pane);
    return () => observer.disconnect();
  }, [textareaRef]);
  return compact;
}
