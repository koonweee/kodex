import { Button, Portal } from "@mantine/core";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import { useInputCapabilities } from "../shared/inputCapabilities";

type CapturedSelection = {
  text: string;
  rangeText: string;
  range: Range;
  body: Element;
  scroll: Element;
  start: Node;
  end: Node;
  startOffset: number;
  endOffset: number;
  draftKey?: string;
};

type Position = { left: number; top: number; maxWidth: number };

function elementFor(node: Node) {
  return node instanceof Element ? node : node.parentElement;
}

function captureSelection(pane: Element, draftKey?: string): CapturedSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const startElement = elementFor(range.startContainer);
  const endElement = elementFor(range.endContainer);
  const body = startElement?.closest(".kodex-assistant-markdown");
  const scroll = body?.closest(".kodex-thread-pane-scroll");
  if (!body || !scroll || endElement?.closest(".kodex-assistant-markdown") !== body ||
      !body.contains(range.commonAncestorContainer) || body.closest(".kodex-thread-pane") !== pane ||
      scroll.closest(".kodex-thread-pane") !== pane || body.closest("aside, [role='complementary']")) return null;
  return {
    text, rangeText: range.toString(), range, body, scroll,
    start: range.startContainer, end: range.endContainer,
    startOffset: range.startOffset, endOffset: range.endOffset, draftKey,
  };
}

function sameSelection(first: CapturedSelection | null, second: CapturedSelection | null) {
  return !!first && !!second && first.start === second.start && first.end === second.end &&
    first.startOffset === second.startOffset && first.endOffset === second.endOffset && first.text === second.text;
}

function isCurrent(selection: CapturedSelection, pane: Element) {
  const { range, body, start, end } = selection;
  return pane.isConnected && body.isConnected && start.isConnected && end.isConnected &&
    body.contains(start) && body.contains(end) && body.closest(".kodex-thread-pane") === pane &&
    body.closest(".kodex-thread-pane-scroll") === selection.scroll &&
    range.startContainer === start && range.endContainer === end &&
    range.startOffset === selection.startOffset && range.endOffset === selection.endOffset &&
    range.toString() === selection.rangeText;
}

function selectionPosition(selection: CapturedSelection, width: number, height: number): Position | null {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const right = left + (viewport?.width ?? window.innerWidth);
  const bottom = top + (viewport?.height ?? window.innerHeight);
  const scroll = selection.scroll.getBoundingClientRect();
  const visible = Array.from(selection.range.getClientRects()).find((rect) =>
    rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(top, scroll.top) &&
    rect.top < Math.min(bottom, scroll.bottom) && rect.right > Math.max(left, scroll.left) &&
    rect.left < Math.min(right, scroll.right));
  if (!visible) return null;
  const margin = 8;
  const maxWidth = Math.max(0, right - left - margin * 2);
  return {
    left: Math.max(left + margin, Math.min(visible.left + visible.width / 2 - width / 2, right - margin - Math.min(width, maxWidth))),
    top: Math.max(top + margin, Math.min(visible.top - height - margin, bottom - height - margin)),
    maxWidth,
  };
}

/** A per-pane action for browser-local selection; its quote never depends on a later DOM read. */
export function AssistantSelectionAction({
  composerShellRef, disabled, draftKey, onAdd,
}: {
  composerShellRef: RefObject<HTMLDivElement | null>;
  disabled: boolean;
  draftKey?: string;
  onAdd: (text: string, pointerType: string | null) => void;
}) {
  const { hasTouchInput } = useInputCapabilities();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const capturedRef = useRef<CapturedSelection | null>(null);
  const dismissedRef = useRef<CapturedSelection | null>(null);
  const actionPointerRef = useRef(false);
  const activationPointerTypeRef = useRef<string | null>(null);
  const sizeRef = useRef({ width: 112, height: hasTouchInput ? 44 : 32 });
  const repositionRef = useRef<() => void>(() => undefined);
  const [position, setPosition] = useState<Position | null>(null);

  useEffect(() => {
    const pane = composerShellRef.current?.closest(".kodex-thread-pane");
    if (!pane) return;
    // A new chat/editability context must not inherit an old native selection.
    dismissedRef.current = capturedRef.current ?? captureSelection(pane, draftKey);
    capturedRef.current = null;
    actionPointerRef.current = false;
    activationPointerTypeRef.current = null;
    setPosition(null);
    if (disabled) return;

    const dismiss = () => {
      dismissedRef.current = capturedRef.current ?? captureSelection(pane, draftKey);
      capturedRef.current = null;
      actionPointerRef.current = false;
      activationPointerTypeRef.current = null;
      setPosition(null);
    };
    const reposition = () => {
      const captured = capturedRef.current;
      if (!captured) return;
      if (!isCurrent(captured, pane)) {
        dismiss();
        return;
      }
      const next = selectionPosition(captured, sizeRef.current.width, sizeRef.current.height);
      setPosition((previous) => previous?.left === next?.left && previous?.top === next?.top &&
        previous?.maxWidth === next?.maxWidth ? previous : next);
    };
    repositionRef.current = reposition;

    const readSelection = () => {
      const next = captureSelection(pane, draftKey);
      if (!next) {
        // Focus/tap on the action can collapse the browser selection before click.
        if (capturedRef.current && (actionPointerRef.current || toolbarRef.current?.contains(document.activeElement)) &&
            (!window.getSelection()?.rangeCount || window.getSelection()?.isCollapsed)) {
          reposition();
          return;
        }
        capturedRef.current = null;
        dismissedRef.current = null;
        setPosition(null);
        return;
      }
      if (sameSelection(next, dismissedRef.current)) return;
      dismissedRef.current = null;
      capturedRef.current = next;
      reposition();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (toolbarRef.current?.contains(event.target)) {
        actionPointerRef.current = true;
      } else if (!capturedRef.current?.body.contains(event.target)) {
        dismiss();
      }
    };
    const onPointerUp = (event: Event) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      actionPointerRef.current = false;
      readSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !toolbarRef.current?.contains(event.target) &&
          !capturedRef.current?.body.contains(event.target)) dismiss();
    };
    const observer = new MutationObserver(reposition);
    observer.observe(pane, { childList: true, subtree: true, characterData: true });
    const resizeObserver = new ResizeObserver(reposition);
    resizeObserver.observe(pane);
    document.addEventListener("selectionchange", readSelection);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerUp);
    document.addEventListener("touchend", onPointerUp);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", readSelection);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", reposition);
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("selectionchange", readSelection);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerUp);
      document.removeEventListener("touchend", onPointerUp);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", readSelection);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("resize", reposition);
      window.visualViewport?.removeEventListener("scroll", reposition);
      repositionRef.current = () => undefined;
    };
  }, [composerShellRef, disabled, draftKey]);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const size = toolbar?.getBoundingClientRect();
    sizeRef.current = { width: size?.width || 112, height: size?.height || (hasTouchInput ? 44 : 32) };
    repositionRef.current();
  }, [position !== null, hasTouchInput]);

  if (!position || disabled || capturedRef.current?.draftKey !== draftKey) return null;
  return (
    <Portal>
      <div ref={toolbarRef} className="kodex-assistant-selection-action" data-touch={hasTouchInput || undefined} style={position}>
        <Button
          size="compact-sm"
          onPointerDown={(event) => { activationPointerTypeRef.current = event.pointerType; }}
          onPointerCancel={() => { activationPointerTypeRef.current = null; }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") activationPointerTypeRef.current = null;
          }}
          onMouseDown={(event) => { if (event.button === 0) event.preventDefault(); }}
          onClick={() => {
            const captured = capturedRef.current;
            const pane = composerShellRef.current?.closest(".kodex-thread-pane");
            const pointerType = activationPointerTypeRef.current;
            activationPointerTypeRef.current = null;
            if (!captured || !pane || !isCurrent(captured, pane)) {
              capturedRef.current = null;
              setPosition(null);
              return;
            }
            dismissedRef.current = captured;
            capturedRef.current = null;
            actionPointerRef.current = false;
            setPosition(null);
            window.getSelection()?.removeAllRanges();
            onAdd(captured.text, pointerType);
          }}
        >Add to chat</Button>
      </div>
    </Portal>
  );
}
