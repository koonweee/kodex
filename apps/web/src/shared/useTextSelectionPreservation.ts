import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import { captureTextSelection, restoreTextSelection, type TextSelectionSnapshot } from "./textSelection";

export function useTextSelectionPreservation(
  rootRef: RefObject<HTMLElement | null>,
  dependency: unknown,
) {
  const pending = useRef<TextSelectionSnapshot | null>(null);
  const deferredClear = useRef<number | null>(null);
  useEffect(() => {
    const cancelDeferredClear = () => {
      if (deferredClear.current !== null) cancelAnimationFrame(deferredClear.current);
      deferredClear.current = null;
    };
    const capture = () => {
      const selected = captureTextSelection(rootRef.current);
      // DOM replacement can collapse the browser selection before the following
      // mutation callback. Defer clearing a collapsed range for one frame, while
      // a real selection in another pane relinquishes this pane immediately.
      if (selected) {
        cancelDeferredClear();
        pending.current = selected;
        return;
      }
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) {
        cancelDeferredClear();
        pending.current = null;
        return;
      }
      cancelDeferredClear();
      deferredClear.current = requestAnimationFrame(() => {
        pending.current = null;
        deferredClear.current = null;
      });
    };
    const clearPending = () => {
      cancelDeferredClear();
      pending.current = null;
    };
    const clearBeforeKeyboardSelection = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Escape", "Home", "PageDown", "PageUp", "Tab"].includes(event.key)) {
        clearPending();
      }
    };
    const restoreAfterViewportChange = () => {
      if (pending.current && rootRef.current) restoreTextSelection(rootRef.current, pending.current);
      window.requestAnimationFrame(() => {
        if (pending.current && rootRef.current) restoreTextSelection(rootRef.current, pending.current);
      });
    };
    const observer = new MutationObserver(() => {
      queueMicrotask(() => {
        if (pending.current && rootRef.current) restoreTextSelection(rootRef.current, pending.current);
      });
    });
    if (rootRef.current) observer.observe(rootRef.current, { childList: true, characterData: true, subtree: true });
    document.addEventListener("selectionchange", capture);
    document.addEventListener("pointerdown", clearPending, true);
    document.addEventListener("keydown", clearBeforeKeyboardSelection, true);
    window.addEventListener("resize", restoreAfterViewportChange);
    return () => {
      cancelDeferredClear();
      document.removeEventListener("selectionchange", capture);
      document.removeEventListener("pointerdown", clearPending, true);
      document.removeEventListener("keydown", clearBeforeKeyboardSelection, true);
      window.removeEventListener("resize", restoreAfterViewportChange);
      observer.disconnect();
    };
  }, [rootRef]);
  useLayoutEffect(() => {
    if (pending.current && rootRef.current) restoreTextSelection(rootRef.current, pending.current);
    return () => {
      pending.current = captureTextSelection(rootRef.current) ?? pending.current;
    };
  }, [dependency, rootRef]);
}
