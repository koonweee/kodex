import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FollowOutput, VirtuosoHandle } from "react-virtuoso";
import {
  getDistanceFromBottom,
  getScrollElementBottomTop,
  isTimelineNearBottom,
  shouldScrollElementToBottom,
  timelineFollowOutputBehavior,
  type TimelineScrollBehavior,
} from "./scrollPolicy";

const TIMELINE_USER_SCROLL_INTENT_WINDOW_MS = 500;
const TIMELINE_AUTO_SCROLL_SETTLE_MS = 120;
type TimelineScrollPolicySource = "measure" | "user";

export function useBottomPinnedVirtuosoTimeline({
  onReady,
  onOverflowAboveChange,
  rowCount,
  scrollParentElement,
  timelineLastSeq,
}: {
  onReady: () => void;
  onOverflowAboveChange?: (hasOverflowAbove: boolean) => void;
  rowCount: number;
  scrollParentElement: HTMLDivElement | null;
  timelineLastSeq: number;
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const isPinnedToBottomRef = useRef(true);
  const autoScrollClearTimeoutRef = useRef<number | null>(null);
  const autoScrollInProgressRef = useRef(false);
  const pendingBottomFollowFrame = useRef<number | null>(null);
  const showScrollToBottomRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [initialBottomAligned, setInitialBottomAligned] = useState(false);
  const [totalListHeight, setTotalListHeight] = useState(0);

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

  const clearAutoScrollMarker = useCallback(() => {
    if (autoScrollClearTimeoutRef.current !== null) {
      window.clearTimeout(autoScrollClearTimeoutRef.current);
      autoScrollClearTimeoutRef.current = null;
    }
    autoScrollInProgressRef.current = false;
  }, []);

  const markAutoScrollInProgress = useCallback(() => {
    autoScrollInProgressRef.current = true;
    if (autoScrollClearTimeoutRef.current !== null) {
      window.clearTimeout(autoScrollClearTimeoutRef.current);
    }
    autoScrollClearTimeoutRef.current = window.setTimeout(() => {
      autoScrollClearTimeoutRef.current = null;
      autoScrollInProgressRef.current = false;
    }, TIMELINE_AUTO_SCROLL_SETTLE_MS);
  }, []);

  const markUserScrollIntent = useCallback(() => {
    clearAutoScrollMarker();
    userScrollIntentUntilRef.current = Date.now() + TIMELINE_USER_SCROLL_INTENT_WINDOW_MS;
  }, [clearAutoScrollMarker]);

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

    if (isNearBottom && (source === "user" || isPinnedToBottomRef.current)) {
      isPinnedToBottomRef.current = true;
      setScrollToBottomVisible(false);
      onOverflowAboveChange?.(Boolean(rowCount > 0 && scrollElement.scrollTop > 8));
      return true;
    }

    if (source === "user" || !isPinnedToBottomRef.current || showScrollToBottomRef.current) {
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
    markAutoScrollInProgress();
    if (scrollParentElement) {
      scrollElementToBottom(scrollParentElement, behavior);
    } else {
      virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior });
    }
  }, [markAutoScrollInProgress, rowCount, scrollParentElement]);

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
    isPinnedToBottomRef.current = true;
    setScrollToBottomVisible(false);
    cancelPendingBottomFollow();
    scrollToTimelineBottom("smooth");
  }, [cancelPendingBottomFollow, scrollToTimelineBottom, setScrollToBottomVisible]);

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

  // Use the native measurement to follow after its DOM update commits.
  const handleTotalListHeightChanged = useCallback((height: number) => {
    setTotalListHeight(height);
  }, []);

  useEffect(() => () => {
    cancelPendingBottomFollow();
    clearAutoScrollMarker();
  }, [cancelPendingBottomFollow, clearAutoScrollMarker]);

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
    const handleScroll = () => {
      const hasRecentUserIntent = Date.now() <= userScrollIntentUntilRef.current;
      const source: TimelineScrollPolicySource = hasRecentUserIntent && !autoScrollInProgressRef.current ? "user" : "measure";
      syncScrollPolicyFromParent(source);
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (isPointerOnScrollbar(event, scrollElement)) {
        markUserScrollIntent();
      }
    };
    const pauseForReading = () => {
      isPinnedToBottomRef.current = false;
      userScrollIntentUntilRef.current = 0;
      cancelPendingBottomFollow();
      clearAutoScrollMarker();
      syncScrollPolicyFromParent();
    };
    const handleDisclosureClick = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("summary, button[aria-expanded]")) {
        pauseForReading();
      }
    };
    const handleKeyboardScrollIntent = (event: KeyboardEvent) => {
      if (isEditableKeyboardTarget(event.target) || !isTimelineScrollKey(event.key)) {
        return;
      }
      markUserScrollIntent();
    };
    // Capture before a disclosure changes height; measurements must not repin it.
    scrollElement.addEventListener("click", handleDisclosureClick, true);
    scrollElement.addEventListener("selectstart", pauseForReading);
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    scrollElement.addEventListener("wheel", markUserScrollIntent, { passive: true });
    scrollElement.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    scrollElement.addEventListener("touchmove", markUserScrollIntent, { passive: true });
    scrollElement.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyboardScrollIntent);
    return () => {
      scrollElement.removeEventListener("click", handleDisclosureClick, true);
      scrollElement.removeEventListener("selectstart", pauseForReading);
      scrollElement.removeEventListener("scroll", handleScroll);
      scrollElement.removeEventListener("wheel", markUserScrollIntent);
      scrollElement.removeEventListener("touchstart", markUserScrollIntent);
      scrollElement.removeEventListener("touchmove", markUserScrollIntent);
      scrollElement.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyboardScrollIntent);
      onOverflowAboveChange?.(false);
    };
  }, [cancelPendingBottomFollow, clearAutoScrollMarker, markUserScrollIntent, onOverflowAboveChange, scrollParentElement, syncScrollPolicyFromParent]);

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

  useLayoutEffect(() => {
    if (!initialBottomAligned || rowCount === 0) {
      return;
    }
    if (isPinnedToBottomRef.current) {
      scrollToTimelineBottom("auto");
    } else {
      syncScrollPolicyFromParent();
    }
  }, [
    initialBottomAligned,
    rowCount,
    scrollToTimelineBottom,
    syncScrollPolicyFromParent,
    timelineLastSeq,
    totalListHeight,
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

function isPointerOnScrollbar(event: PointerEvent, scrollElement: HTMLElement) {
  const rect = scrollElement.getBoundingClientRect();
  const verticalScrollbarWidth = scrollElement.offsetWidth - scrollElement.clientWidth;
  const horizontalScrollbarHeight = scrollElement.offsetHeight - scrollElement.clientHeight;
  const isOnVerticalScrollbar =
    verticalScrollbarWidth > 0 &&
    event.clientX >= rect.right - verticalScrollbarWidth &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom;
  const isOnHorizontalScrollbar =
    horizontalScrollbarHeight > 0 &&
    event.clientY >= rect.bottom - horizontalScrollbarHeight &&
    event.clientY <= rect.bottom &&
    event.clientX >= rect.left &&
    event.clientX <= rect.right;
  return isOnVerticalScrollbar || isOnHorizontalScrollbar;
}

function isTimelineScrollKey(key: string) {
  return ["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "].includes(key);
}

function isEditableKeyboardTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);
}
