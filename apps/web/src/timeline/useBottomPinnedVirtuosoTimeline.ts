import { useCallback, useEffect, useRef, useState } from "react";
import type { FollowOutput, VirtuosoHandle } from "react-virtuoso";
import {
  getDistanceFromBottom,
  getScrollElementBottomTop,
  isTimelineNearBottom,
  shouldScrollElementToBottom,
  timelineFollowOutputBehavior,
  type TimelineScrollBehavior,
} from "./scrollPolicy";

type TimelineScrollPolicySource = "away" | "measure" | "toward" | "user";

export function useBottomPinnedVirtuosoTimeline({
  onReady,
  onOverflowAboveChange,
  rowCount,
  scrollParentElement,
  threadId,
}: {
  onReady: () => void;
  onOverflowAboveChange?: (hasOverflowAbove: boolean) => void;
  rowCount: number;
  scrollParentElement: HTMLDivElement | null;
  threadId?: string;
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const isPinnedToBottomRef = useRef(true);
  const activeUserScrollRef = useRef<Exclude<TimelineScrollPolicySource, "measure"> | null>(null);
  const bottomOriginDisclosureRef = useRef<Element | null>(null);
  const pendingDisclosureCollapseRef = useRef<{ startHeight: number } | null>(null);
  const disclosureRecoveryRevisionRef = useRef(0);
  const measuredListHeightRef = useRef<number | null>(null);
  const pendingBottomFollowFrame = useRef<number | null>(null);
  const showScrollToBottomRef = useRef(false);
  const touchYRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [initialBottomAligned, setInitialBottomAligned] = useState(false);

  const setScrollToBottomVisible = useCallback((visible: boolean) => {
    showScrollToBottomRef.current = visible;
    setShowScrollToBottom(visible);
  }, []);

  const cancelPendingBottomFollow = useCallback(() => {
    if (pendingBottomFollowFrame.current !== null) {
      cancelAnimationFrame(pendingBottomFollowFrame.current);
      pendingBottomFollowFrame.current = null;
    }
  }, []);

  const clearDisclosureRecovery = useCallback(() => {
    bottomOriginDisclosureRef.current = null;
    pendingDisclosureCollapseRef.current = null;
    disclosureRecoveryRevisionRef.current += 1;
  }, []);

  const syncScrollPolicyFromParent = useCallback((source: TimelineScrollPolicySource = "measure") => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      isPinnedToBottomRef.current = true;
      setScrollToBottomVisible(false);
      onOverflowAboveChange?.(false);
      return true;
    }
    const distanceFromBottom = getDistanceFromBottom(scrollElement);
    const isNearBottom = isTimelineNearBottom(scrollElement);

    if (isNearBottom && source !== "away" && (source !== "measure" || isPinnedToBottomRef.current)) {
      isPinnedToBottomRef.current = true;
      setScrollToBottomVisible(false);
      onOverflowAboveChange?.(Boolean(rowCount > 0 && scrollElement.scrollTop > 8));
      return true;
    }

    if (source !== "measure" || !isPinnedToBottomRef.current || showScrollToBottomRef.current) {
      isPinnedToBottomRef.current = false;
      cancelPendingBottomFollow();
      setScrollToBottomVisible(rowCount > 0 && distanceFromBottom > 0);
      onOverflowAboveChange?.(Boolean(rowCount > 0 && scrollElement.scrollTop > 8));
      return false;
    }

    setScrollToBottomVisible(false);
    onOverflowAboveChange?.(Boolean(rowCount > 0 && scrollElement.scrollTop > 8));
    return true;
  }, [cancelPendingBottomFollow, onOverflowAboveChange, rowCount, scrollParentElement, setScrollToBottomVisible]);

  const scrollToTimelineBottom = useCallback((behavior: TimelineScrollBehavior = "auto") => {
    if (rowCount === 0) {
      return;
    }
    if (scrollParentElement && behavior === "auto" && !shouldScrollElementToBottom(scrollParentElement)) {
      return;
    }
    if (scrollParentElement) {
      scrollElementToBottom(scrollParentElement, behavior);
    } else {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior });
    }
  }, [rowCount, scrollParentElement]);

  const scheduleBottomFollow = useCallback(
    (behavior: TimelineScrollBehavior = "auto") => {
      if (rowCount === 0 || pendingBottomFollowFrame.current !== null) {
        return;
      }
      pendingBottomFollowFrame.current = requestAnimationFrame(() => {
        if (!isPinnedToBottomRef.current && behavior === "auto") {
          pendingBottomFollowFrame.current = null;
          return;
        }
        pendingBottomFollowFrame.current = null;
        scrollToTimelineBottom(behavior);
        if (behavior === "auto") syncScrollPolicyFromParent();
      });
    },
    [rowCount, scrollToTimelineBottom, syncScrollPolicyFromParent],
  );

  const markTimelineReady = useCallback(() => {
    // Native initial alignment targets the last item, excluding scroll-parent padding.
    if (isPinnedToBottomRef.current) scrollToTimelineBottom("auto");
    setInitialBottomAligned(true);
    onReady();
  }, [onReady, scrollToTimelineBottom]);

  const scrollToBottom = useCallback(() => {
    activeUserScrollRef.current = null;
    clearDisclosureRecovery();
    isPinnedToBottomRef.current = true;
    setScrollToBottomVisible(false);
    cancelPendingBottomFollow();
    scrollToTimelineBottom("smooth");
  }, [cancelPendingBottomFollow, clearDisclosureRecovery, scrollToTimelineBottom, setScrollToBottomVisible]);

  const handleAtBottomStateChange = useCallback(
    (atBottom: boolean) => {
      if (scrollParentElement) {
        syncScrollPolicyFromParent();
        return;
      }
      isPinnedToBottomRef.current = atBottom;
      if (!atBottom) {
        cancelPendingBottomFollow();
      }
      setScrollToBottomVisible(!atBottom && rowCount > 0);
    },
    [cancelPendingBottomFollow, rowCount, scrollParentElement, setScrollToBottomVisible, syncScrollPolicyFromParent],
  );

  // Virtuoso has committed its measurement by the time this fires. Keep the
  // value out of React state: only the scroll policy needs to react to it.
  const handleTotalListHeightChanged = useCallback((measuredListHeight: number) => {
    measuredListHeightRef.current = measuredListHeight;
    const pendingCollapse = pendingDisclosureCollapseRef.current;
    if (pendingCollapse && measuredListHeight < pendingCollapse.startHeight) {
      pendingDisclosureCollapseRef.current = null;
      const recoveryRevision = disclosureRecoveryRevisionRef.current;
      requestAnimationFrame(() => {
        if (
          disclosureRecoveryRevisionRef.current === recoveryRevision &&
          !isPinnedToBottomRef.current &&
          scrollParentElement &&
          !shouldScrollElementToBottom(scrollParentElement)
        ) {
          syncScrollPolicyFromParent("toward");
        }
      });
    }
    if (isPinnedToBottomRef.current) {
      scheduleBottomFollow("auto");
    } else {
      syncScrollPolicyFromParent();
    }
  }, [scheduleBottomFollow, scrollParentElement, syncScrollPolicyFromParent]);

  useEffect(() => () => {
    cancelPendingBottomFollow();
  }, [cancelPendingBottomFollow]);

  useEffect(() => {
    measuredListHeightRef.current = null;
    clearDisclosureRecovery();
  }, [clearDisclosureRecovery, threadId]);

  const followOutput = useCallback<Exclude<FollowOutput, boolean | string>>(
    () => timelineFollowOutputBehavior(isPinnedToBottomRef.current && !showScrollToBottomRef.current),
    [],
  );

  useEffect(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      return;
    }

    syncScrollPolicyFromParent();
    let lastScrollTop = scrollElement.scrollTop;
    let pointerIntentClearFrame: number | null = null;
    let selectionPauseFrame: number | null = null;
    const cancelPointerIntentClear = () => {
      if (pointerIntentClearFrame !== null) cancelAnimationFrame(pointerIntentClearFrame);
      pointerIntentClearFrame = null;
    };
    const handleScroll = () => {
      const currentScrollTop = scrollElement.scrollTop;
      const activeSource = activeUserScrollRef.current;
      if (activeSource !== null && currentScrollTop !== lastScrollTop) clearDisclosureRecovery();
      const source = activeSource === "user"
        ? currentScrollTop < lastScrollTop ? "away" : currentScrollTop > lastScrollTop ? "toward" : "user"
        : activeSource ?? "measure";
      lastScrollTop = currentScrollTop;
      syncScrollPolicyFromParent(source);
    };
    const clearUserScrollIntent = () => {
      cancelPointerIntentClear();
      activeUserScrollRef.current = null;
      touchYRef.current = null;
    };
    const handlePointerDown = () => {
      cancelPointerIntentClear();
      lastScrollTop = scrollElement.scrollTop;
      activeUserScrollRef.current = "user";
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (pointerIntentClearFrame !== null) cancelAnimationFrame(pointerIntentClearFrame);
      pointerIntentClearFrame = requestAnimationFrame(() => {
        pointerIntentClearFrame = null;
        activeUserScrollRef.current = null;
        touchYRef.current = null;
      });
    };
    const pauseForReading = () => {
      cancelPointerIntentClear();
      activeUserScrollRef.current = null;
      touchYRef.current = null;
      clearDisclosureRecovery();
      isPinnedToBottomRef.current = false;
      cancelPendingBottomFollow();
      syncScrollPolicyFromParent("away");
    };
    const handleWheel = (event: WheelEvent) => {
      cancelPointerIntentClear();
      if (event.deltaY !== 0) clearDisclosureRecovery();
      activeUserScrollRef.current = event.deltaY < 0 ? "away" : event.deltaY > 0 ? "toward" : "user";
      if (activeUserScrollRef.current === "away") pauseForReading();
    };
    const handleTouchStart = (event: TouchEvent) => {
      cancelPointerIntentClear();
      touchYRef.current = event.touches[0]?.clientY ?? null;
      activeUserScrollRef.current = "user";
    };
    const handleTouchMove = (event: TouchEvent) => {
      const currentY = event.touches[0]?.clientY;
      const previousY = touchYRef.current;
      if (currentY === undefined || previousY === null) return;
      cancelPointerIntentClear();
      clearDisclosureRecovery();
      activeUserScrollRef.current = currentY > previousY ? "away" : currentY < previousY ? "toward" : "user";
      touchYRef.current = currentY;
      if (activeUserScrollRef.current === "away") pauseForReading();
    };
    const handleDisclosureClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const disclosure = disclosureElementForTarget(event.target);
      if (!disclosure) return;
      const expanded = disclosure instanceof HTMLDetailsElement
        ? disclosure.open
        : disclosure.getAttribute("aria-expanded") === "true";
      if (expanded && disclosure === bottomOriginDisclosureRef.current) {
        bottomOriginDisclosureRef.current = null;
        const measuredListHeight = measuredListHeightRef.current;
        pendingDisclosureCollapseRef.current = measuredListHeight === null ? null : { startHeight: measuredListHeight };
        activeUserScrollRef.current = null;
        touchYRef.current = null;
        isPinnedToBottomRef.current = false;
        cancelPendingBottomFollow();
        syncScrollPolicyFromParent("away");
        return;
      }
      const startedPinned = isPinnedToBottomRef.current && !showScrollToBottomRef.current;
      pauseForReading();
      if (!expanded && startedPinned) {
        bottomOriginDisclosureRef.current = disclosure;
      }
    };
    const pauseForTimelineSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const anchorInTimeline = selection.anchorNode !== null && scrollElement.contains(selection.anchorNode);
      const focusInTimeline = selection.focusNode !== null && scrollElement.contains(selection.focusNode);
      if (anchorInTimeline || focusInTimeline) pauseForReading();
    };
    const handleSelectStart = () => {
      if (selectionPauseFrame !== null) cancelAnimationFrame(selectionPauseFrame);
      selectionPauseFrame = requestAnimationFrame(() => {
        selectionPauseFrame = null;
        pauseForTimelineSelection();
      });
    };
    const handleKeyboardScrollIntent = (event: KeyboardEvent) => {
      if (!isTimelineKeyboardTarget(event.target, scrollElement) || isEditableKeyboardTarget(event.target)) {
        return;
      }
      const direction = getTimelineKeyboardScrollDirection(event);
      if (!direction) return;
      cancelPointerIntentClear();
      activeUserScrollRef.current = direction;
      clearDisclosureRecovery();
      if (direction === "away") pauseForReading();
    };
    // Capture before a disclosure changes height. Measurement may resume follow
    // only when the resulting viewport is at the exact bottom.
    scrollElement.addEventListener("click", handleDisclosureClick, true);
    scrollElement.addEventListener("selectstart", handleSelectStart);
    document.addEventListener("selectionchange", pauseForTimelineSelection);
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    scrollElement.addEventListener("scrollend", clearUserScrollIntent);
    scrollElement.addEventListener("wheel", handleWheel, { passive: true });
    scrollElement.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollElement.addEventListener("touchmove", handleTouchMove, { passive: true });
    scrollElement.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("pointercancel", handlePointerEnd);
    document.addEventListener("pointerup", handlePointerEnd);
    document.addEventListener("keydown", handleKeyboardScrollIntent);
    return () => {
      scrollElement.removeEventListener("click", handleDisclosureClick, true);
      scrollElement.removeEventListener("selectstart", handleSelectStart);
      document.removeEventListener("selectionchange", pauseForTimelineSelection);
      scrollElement.removeEventListener("scroll", handleScroll);
      scrollElement.removeEventListener("scrollend", clearUserScrollIntent);
      scrollElement.removeEventListener("wheel", handleWheel);
      scrollElement.removeEventListener("touchstart", handleTouchStart);
      scrollElement.removeEventListener("touchmove", handleTouchMove);
      scrollElement.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("pointercancel", handlePointerEnd);
      document.removeEventListener("pointerup", handlePointerEnd);
      document.removeEventListener("keydown", handleKeyboardScrollIntent);
      cancelPointerIntentClear();
      if (selectionPauseFrame !== null) cancelAnimationFrame(selectionPauseFrame);
      clearDisclosureRecovery();
      onOverflowAboveChange?.(false);
    };
  }, [cancelPendingBottomFollow, clearDisclosureRecovery, onOverflowAboveChange, scrollParentElement, syncScrollPolicyFromParent]);

  useEffect(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (isPinnedToBottomRef.current) {
        scheduleBottomFollow("auto");
      } else {
        syncScrollPolicyFromParent();
      }
    });
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [scheduleBottomFollow, scrollParentElement, syncScrollPolicyFromParent]);

  useEffect(() => {
    if (initialBottomAligned) {
      return;
    }

    if (rowCount === 0) {
      isPinnedToBottomRef.current = true;
      setScrollToBottomVisible(false);
      markTimelineReady();
      return;
    }

    if (!isPinnedToBottomRef.current) {
      setScrollToBottomVisible(true);
      markTimelineReady();
      return;
    }

    scheduleBottomFollow("auto");
    let readyFrameId: number | null = null;
    const frameId = requestAnimationFrame(() => {
      syncScrollPolicyFromParent();
      readyFrameId = requestAnimationFrame(markTimelineReady);
    });
    return () => {
      cancelAnimationFrame(frameId);
      if (readyFrameId !== null) {
        cancelAnimationFrame(readyFrameId);
      }
    };
  }, [
    initialBottomAligned,
    markTimelineReady,
    rowCount,
    scheduleBottomFollow,
    setScrollToBottomVisible,
    syncScrollPolicyFromParent,
  ]);

  return {
    followOutput,
    handleAtBottomStateChange,
    handleTotalListHeightChanged,
    initialBottomAligned,
    scrollToBottom,
    showScrollToBottom,
    virtuosoRef,
  };
}

function scrollElementToBottom(scrollElement: HTMLElement, behavior: TimelineScrollBehavior) {
  if (!shouldScrollElementToBottom(scrollElement)) {
    return;
  }
  const top = getScrollElementBottomTop(scrollElement);
  if (top === 0) {
    scrollElement.scrollTop = 0;
    return;
  }
  if (behavior === "smooth" && typeof scrollElement.scrollTo === "function") {
    scrollElement.scrollTo({ top, behavior });
    return;
  }
  scrollElement.scrollTop = top;
}

function getTimelineKeyboardScrollDirection(event: KeyboardEvent): "away" | "toward" | null {
  if (["ArrowUp", "Home", "PageUp"].includes(event.key) || (event.key === " " && event.shiftKey)) return "away";
  if (["ArrowDown", "End", "PageDown", " "].includes(event.key)) return "toward";
  return null;
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}

function isTimelineKeyboardTarget(target: EventTarget | null, scrollElement: HTMLElement) {
  if (!(target instanceof Element)) return false;
  if (scrollElement.contains(target)) return true;
  if (target !== document.body && target !== document.documentElement) return false;
  return scrollElement.matches(".kodex-thread-pane-scroll")
    && scrollElement.closest('[data-workspace-pane-active="true"]') !== null;
}

function disclosureElementForTarget(target: Element): Element | null {
  const summary = target.closest("summary");
  if (summary?.parentElement instanceof HTMLDetailsElement) return summary.parentElement;
  return target.closest("button[aria-expanded]");
}
