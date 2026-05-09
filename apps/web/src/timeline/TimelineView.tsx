import { ActionIcon, Box, Stack, Tooltip } from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useEffect } from "react";

import type { Approval, ApprovalResponse } from "../api/client";
import type { MarkdownPreviewRequest } from "../files/types";
import { ApprovalCard, ThreadApprovalStack } from "../approvals/ApprovalCard";
import type { ImageLightboxImage } from "../images/types";
import {
  buildApprovalIndex,
  deriveTimelineRows,
  getTimelineRowApprovals,
  getUnanchoredApprovals,
  type TimelineRow,
} from "./derive";
import { TimelineActivityGroupRenderer, TimelineFileChangesRenderer, TimelineItemRenderer, TimelineWorkRowRenderer } from "./renderers";
import type { TimelineState } from "./reducer";

const EMPTY_APPROVALS: Approval[] = [];
const INITIAL_BOTTOM_STABLE_FRAMES = 3;
const INITIAL_BOTTOM_MAX_SETTLE_FRAMES = 90;
const LIVE_BOTTOM_SETTLE_FRAMES = 8;
const BOTTOM_DISTANCE_EPSILON = 2;
const disableTimelineScrollAdjustment = () => false;

const TIMELINE_TEXT = {
  scrollToBottom: "Scroll to bottom",
};

export function TimelineView({
  approvals,
  followLiveToken = 0,
  imagePreviewUrlsByPath,
  onApprovalDecision,
  onImageOpen,
  onMarkdownOpen,
  onReady,
  scrollParentElement,
  showDebug,
  threadId,
  timeline,
}: {
  approvals: Approval[];
  followLiveToken?: number;
  imagePreviewUrlsByPath: Record<string, string>;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  onReady: () => void;
  scrollParentElement: HTMLDivElement | null;
  showDebug: boolean;
  threadId?: string;
  timeline: TimelineState;
}) {
  const rows = useMemo(() => deriveTimelineRows(timeline, { showDebug }), [showDebug, timeline]);
  const approvalIndex = useMemo(() => buildApprovalIndex(approvals), [approvals]);
  const unanchoredApprovals = useMemo(
    () => getUnanchoredApprovals(rows, approvalIndex),
    [approvalIndex, rows],
  );
  const approvalsByRowKey = useMemo(() => buildTimelineRowApprovalMap(rows, approvalIndex), [approvalIndex, rows]);
  const rowCount = rows.length;
  const {
    initialBottomAligned,
    isNearBottom,
    rowVirtualizer,
    scrollToBottom,
    showScrollToBottom,
  } = useBottomPinnedVirtualTimeline({
    followLiveToken,
    onReady,
    rows,
    scrollParentElement,
    timelineLastSeq: timeline.lastSeq,
  });

  if (rowCount === 0) {
    return (
      <>
        <HiddenDebugPanel
          hiddenItems={showDebug ? timeline.hiddenItems : []}
          imagePreviewUrlsByPath={imagePreviewUrlsByPath}
          onImageOpen={onImageOpen}
          onMarkdownOpen={onMarkdownOpen}
          threadId={threadId}
        />
        {approvals.length > 0 ? <ThreadApprovalStack approvals={approvals} onDecision={onApprovalDecision} /> : null}
      </>
    );
  }

  const virtualItems = rowVirtualizer.getVirtualItems();
  const renderedVirtualItems =
    virtualItems.length > 0 ? virtualItems : fallbackVirtualItems(rows, isNearBottom);

  return (
    <Box className="kodex-timeline-virtual-root" data-initial-bottom-aligned={initialBottomAligned ? "true" : "false"}>
      <Box className="kodex-timeline-virtual-spacer" style={{ height: rowVirtualizer.getTotalSize() }}>
        {renderedVirtualItems.map((virtualItem) => {
          const row = rows[virtualItem.index];
          if (!row) {
            return null;
          }
          return (
            <Box
              className="kodex-timeline-virtual-row kodex-main-column"
              data-index={virtualItem.index}
              key={virtualItem.key}
              ref={rowVirtualizer.measureElement}
              style={{ transform: `translateY(${virtualItem.start}px)` }}
              onToggle={(event) => {
                if (event.target instanceof HTMLDetailsElement) {
                  rowVirtualizer.measureElement(event.currentTarget);
                }
              }}
            >
              <TimelineRowView
                approvals={approvalsByRowKey.get(row.key) ?? EMPTY_APPROVALS}
                imagePreviewUrlsByPath={imagePreviewUrlsByPath}
                onApprovalDecision={onApprovalDecision}
                onImageOpen={onImageOpen}
                onMarkdownOpen={onMarkdownOpen}
                row={row}
                showDebug={showDebug}
                threadId={threadId}
              />
            </Box>
          );
        })}
      </Box>
      <HiddenDebugPanel
        hiddenItems={showDebug ? timeline.hiddenItems : []}
        imagePreviewUrlsByPath={imagePreviewUrlsByPath}
        onImageOpen={onImageOpen}
        onMarkdownOpen={onMarkdownOpen}
        threadId={threadId}
      />
      {unanchoredApprovals.length > 0 ? (
        <ThreadApprovalStack approvals={unanchoredApprovals} onDecision={onApprovalDecision} />
      ) : null}
      {showScrollToBottom ? (
        <Tooltip label={TIMELINE_TEXT.scrollToBottom}>
          <ActionIcon
            aria-label={TIMELINE_TEXT.scrollToBottom}
            className="kodex-scroll-to-bottom"
            color="gray"
            onClick={scrollToBottom}
            radius="xl"
            size="md"
            variant="light"
          >
            <ArrowDownToLine size={16} />
          </ActionIcon>
        </Tooltip>
      ) : null}
    </Box>
  );
}

function HiddenDebugPanel({
  hiddenItems,
  imagePreviewUrlsByPath,
  onImageOpen,
  onMarkdownOpen,
  threadId,
}: {
  hiddenItems: TimelineState["hiddenItems"];
  imagePreviewUrlsByPath: Record<string, string>;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  threadId?: string;
}) {
  if (hiddenItems.length === 0) {
    return null;
  }
  return (
    <Box className="kodex-hidden-debug-panel kodex-main-column">
      <details>
        <summary>Hidden debug events</summary>
        <Stack gap={8} mt={8}>
          {hiddenItems.map((item) => (
            <TimelineItemRenderer
              imagePreviewUrlsByPath={imagePreviewUrlsByPath}
              item={item}
              key={item.id}
              onImageOpen={onImageOpen}
              onMarkdownOpen={onMarkdownOpen}
              showDebug
              threadId={threadId}
            />
          ))}
        </Stack>
      </details>
    </Box>
  );
}

function useBottomPinnedVirtualTimeline({
  followLiveToken,
  onReady,
  rows,
  scrollParentElement,
  timelineLastSeq,
}: {
  followLiveToken: number;
  onReady: () => void;
  rows: TimelineRow[];
  scrollParentElement: HTMLDivElement | null;
  timelineLastSeq: number;
}) {
  const rowCount = rows.length;
  const lastRowKey = rows[rowCount - 1]?.key ?? "";
  const followingLiveRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const nearBottomRef = useRef(true);
  const touchStartYRef = useRef<number | null>(null);
  const upwardIntentRef = useRef(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [initialBottomAligned, setInitialBottomAligned] = useState(false);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    estimateSize: () => 112,
    getItemKey: (index) => rows[index]?.key ?? index,
    getScrollElement: () => scrollParentElement,
    initialRect: { width: 900, height: 720 },
    overscan: 8,
  });
  rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = disableTimelineScrollAdjustment;

  const updateNearBottom = useCallback(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      nearBottomRef.current = true;
      followingLiveRef.current = true;
      lastScrollTopRef.current = 0;
      upwardIntentRef.current = false;
      setShowScrollToBottom(false);
      return true;
    }
    const distanceFromBottom = getDistanceFromBottom(scrollElement);
    const isAtBottom = distanceFromBottom <= BOTTOM_DISTANCE_EPSILON;
    const isNearBottom = distanceFromBottom < 96;
    const previousScrollTop = lastScrollTopRef.current;
    const movedUp = scrollElement.scrollTop < previousScrollTop;
    const movedDown = scrollElement.scrollTop > previousScrollTop;
    if ((movedUp || movedDown) && !isNearBottom) {
      followingLiveRef.current = false;
    }
    if (isAtBottom && (!upwardIntentRef.current || movedDown)) {
      upwardIntentRef.current = false;
      followingLiveRef.current = true;
    }
    lastScrollTopRef.current = scrollElement.scrollTop;
    nearBottomRef.current = isNearBottom;
    setShowScrollToBottom(!isNearBottom && rowCount > 0 && distanceFromBottom > 0);
    return isNearBottom;
  }, [rowCount, scrollParentElement]);

  const stopFollowingLive = useCallback(() => {
    upwardIntentRef.current = true;
    followingLiveRef.current = false;
  }, []);

  const scrollToTimelineBottom = useCallback(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      return;
    }
    rowVirtualizer.scrollToIndex(Math.max(0, rowCount - 1), { align: "end" });
    scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  }, [rowCount, rowVirtualizer, scrollParentElement]);

  const settleToTimelineBottom = useCallback(() => {
    const frameIds: number[] = [];
    let previousBottom = -1;
    let stableFrames = 0;

    const settle = (remainingFrames: number) => {
      if (!followingLiveRef.current) {
        updateNearBottom();
        return;
      }

      scrollToTimelineBottom();
      const scrollElement = scrollParentElement;
      const nextBottom = scrollElement ? Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight) : 0;
      stableFrames = nextBottom === previousBottom ? stableFrames + 1 : 0;
      previousBottom = nextBottom;
      updateNearBottom();

      if (remainingFrames <= 0 || stableFrames >= 2) {
        return;
      }

      frameIds.push(requestAnimationFrame(() => settle(remainingFrames - 1)));
    };

    settle(LIVE_BOTTOM_SETTLE_FRAMES);

    return () => {
      for (const frameId of frameIds) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [scrollParentElement, scrollToTimelineBottom, updateNearBottom]);

  const markTimelineReady = useCallback(() => {
    setInitialBottomAligned(true);
    onReady();
  }, [onReady]);

  const finishInitialBottomReveal = useCallback(() => {
    scrollToTimelineBottom();
    updateNearBottom();
    markTimelineReady();
  }, [markTimelineReady, scrollToTimelineBottom, updateNearBottom]);

  const scrollToBottom = useCallback(() => {
    upwardIntentRef.current = false;
    followingLiveRef.current = true;
    nearBottomRef.current = true;
    setShowScrollToBottom(false);

    settleToTimelineBottom();
  }, [settleToTimelineBottom]);

  useEffect(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      return;
    }

    updateNearBottom();
    scrollElement.addEventListener("scroll", updateNearBottom, { passive: true });

    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) {
        stopFollowingLive();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const isUpwardKey =
        event.key === "ArrowUp" ||
        event.key === "Home" ||
        event.key === "PageUp" ||
        (event.key === " " && event.shiftKey);
      if (isUpwardKey) {
        stopFollowingLive();
      }
    };
    const handleTouchStart = (event: TouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      const startY = touchStartYRef.current;
      const currentY = event.touches[0]?.clientY;
      if (startY !== null && currentY !== undefined && currentY > startY) {
        stopFollowingLive();
      }
    };

    scrollElement.addEventListener("wheel", handleWheel, { passive: true });
    scrollElement.addEventListener("keydown", handleKeyDown);
    scrollElement.addEventListener("touchstart", handleTouchStart, { passive: true });
    scrollElement.addEventListener("touchmove", handleTouchMove, { passive: true });
    return () => {
      scrollElement.removeEventListener("scroll", updateNearBottom);
      scrollElement.removeEventListener("wheel", handleWheel);
      scrollElement.removeEventListener("keydown", handleKeyDown);
      scrollElement.removeEventListener("touchstart", handleTouchStart);
      scrollElement.removeEventListener("touchmove", handleTouchMove);
    };
  }, [scrollParentElement, stopFollowingLive, updateNearBottom]);

  useLayoutEffect(() => {
    if (initialBottomAligned) {
      return;
    }

    if (rowCount === 0) {
      setShowScrollToBottom(false);
      markTimelineReady();
      return;
    }

    if (!nearBottomRef.current) {
      setShowScrollToBottom(true);
      markTimelineReady();
      return;
    }

    const frameIds: number[] = [];
    const settleBottom = (
      attempt: number,
      stableFrames: number,
      previousSnapshot: TimelineInitialBottomSettleSnapshot | null,
    ) => {
      if (!nearBottomRef.current) {
        markTimelineReady();
        return;
      }

      scrollToTimelineBottom();
      const frameId = requestAnimationFrame(() => {
        const scrollElement = scrollParentElement;
        const snapshot = getTimelineInitialBottomSettleSnapshot(
          scrollElement,
          rowVirtualizer.getTotalSize(),
          rowVirtualizer.getVirtualItems(),
          rowCount,
        );
        const nextStableFrames = isTimelineInitialBottomSettled(snapshot, previousSnapshot) ? stableFrames + 1 : 0;

        if (isTimelineInitialBottomRevealReady(nextStableFrames, attempt)) {
          finishInitialBottomReveal();
          return;
        }

        settleBottom(attempt + 1, nextStableFrames, snapshot);
      });
      frameIds.push(frameId);
    };

    settleBottom(0, 0, null);
    return () => {
      for (const frameId of frameIds) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [
    finishInitialBottomReveal,
    initialBottomAligned,
    markTimelineReady,
    rowCount,
    scrollParentElement,
    scrollToTimelineBottom,
  ]);

  useLayoutEffect(() => {
    if (!initialBottomAligned || rowCount === 0) {
      return;
    }

    if (followingLiveRef.current) {
      return settleToTimelineBottom();
    }

    updateNearBottom();
  }, [
    initialBottomAligned,
    lastRowKey,
    rowCount,
    settleToTimelineBottom,
    timelineLastSeq,
    updateNearBottom,
  ]);

  useLayoutEffect(() => {
    if (!initialBottomAligned || rowCount === 0 || followLiveToken === 0) {
      return;
    }

    scrollToBottom();
  }, [followLiveToken, initialBottomAligned, rowCount, scrollToBottom]);

  return {
    initialBottomAligned,
    isNearBottom: nearBottomRef.current,
    rowVirtualizer,
    scrollToBottom,
    showScrollToBottom,
  };
}

const TimelineRowView = memo(function TimelineRowView({
  approvals,
  imagePreviewUrlsByPath,
  onApprovalDecision,
  onImageOpen,
  onMarkdownOpen,
  row,
  showDebug,
  threadId,
}: {
  approvals: Approval[];
  imagePreviewUrlsByPath: Record<string, string>;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  row: TimelineRow;
  showDebug: boolean;
  threadId?: string;
}) {
  return (
    <Box className="kodex-turn-group">
      {row.type !== "work" && row.dividerBefore === "final_response" ? (
        <Box aria-hidden="true" className="kodex-timeline-final-response-divider" />
      ) : null}
      {row.type === "work" ? (
        <TimelineWorkRowRenderer
          imagePreviewUrlsByPath={imagePreviewUrlsByPath}
          onImageOpen={onImageOpen}
          onMarkdownOpen={onMarkdownOpen}
          row={row}
          showDebug={showDebug}
          threadId={threadId}
        />
      ) : row.type === "activity" ? (
        <TimelineActivityGroupRenderer
          imagePreviewUrlsByPath={imagePreviewUrlsByPath}
          items={row.items}
          onImageOpen={onImageOpen}
          onMarkdownOpen={onMarkdownOpen}
          showDebug={showDebug}
          threadId={threadId}
        />
      ) : row.type === "file_changes" ? (
        <TimelineFileChangesRenderer items={row.items} showDebug={showDebug} />
      ) : (
        <TimelineItemRenderer
          item={row.item}
          imagePreviewUrlsByPath={imagePreviewUrlsByPath}
          onImageOpen={onImageOpen}
          onMarkdownOpen={onMarkdownOpen}
          showDebug={showDebug}
          threadId={threadId}
        />
      )}
      {approvals.length > 0 ? (
        <Stack gap="xs" mt="xs">
          {approvals.map((approval) => (
            <ApprovalCard approval={approval} key={approval.id} onDecision={onApprovalDecision} />
          ))}
        </Stack>
      ) : null}
    </Box>
  );
});

function fallbackVirtualItems(rows: TimelineRow[], preferBottom: boolean) {
  const fallbackCount = Math.min(rows.length, 12);
  const startIndex = preferBottom ? Math.max(0, rows.length - fallbackCount) : 0;
  return rows.slice(startIndex, startIndex + fallbackCount).map((row, offset) => ({
    index: startIndex + offset,
    key: row.key,
    start: (startIndex + offset) * 112,
  }));
}

function buildTimelineRowApprovalMap(rows: TimelineRow[], approvalIndex: ReturnType<typeof buildApprovalIndex>) {
  const approvalsByRowKey = new Map<string, Approval[]>();
  for (const row of rows) {
    const rowApprovals = getTimelineRowApprovals(row, approvalIndex);
    if (rowApprovals.length > 0) {
      approvalsByRowKey.set(row.key, rowApprovals);
    }
  }
  return approvalsByRowKey;
}

function getDistanceFromBottom(scrollElement: HTMLElement) {
  return scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
}

export type TimelineInitialBottomSettleSnapshot = {
  distanceFromBottom: number;
  hasRenderedDomBottom: boolean;
  hasRenderedVirtualBottom: boolean;
  scrollHeight: number;
  totalSize: number;
};

function getTimelineInitialBottomSettleSnapshot(
  scrollElement: HTMLElement | null,
  totalSize: number,
  virtualItems: Array<{ index: number }>,
  rowCount: number,
): TimelineInitialBottomSettleSnapshot {
  if (!scrollElement) {
    return {
      distanceFromBottom: 0,
      hasRenderedDomBottom: true,
      hasRenderedVirtualBottom: true,
      scrollHeight: 0,
      totalSize,
    };
  }

  return {
    distanceFromBottom: getDistanceFromBottom(scrollElement),
    hasRenderedDomBottom: hasRenderedTimelineBottom(scrollElement, rowCount),
    hasRenderedVirtualBottom: hasRenderedVirtualTimelineBottom(virtualItems, rowCount),
    scrollHeight: scrollElement.scrollHeight,
    totalSize,
  };
}

export function isTimelineInitialBottomSettled(
  snapshot: TimelineInitialBottomSettleSnapshot,
  previousSnapshot: TimelineInitialBottomSettleSnapshot | null,
) {
  if (!previousSnapshot) {
    return false;
  }
  return (
    snapshot.scrollHeight === previousSnapshot.scrollHeight &&
    snapshot.totalSize === previousSnapshot.totalSize &&
    snapshot.hasRenderedDomBottom &&
    snapshot.hasRenderedVirtualBottom &&
    Math.abs(snapshot.distanceFromBottom) < BOTTOM_DISTANCE_EPSILON
  );
}

export function isTimelineInitialBottomRevealReady(stableFrames: number, attempt: number) {
  return stableFrames >= INITIAL_BOTTOM_STABLE_FRAMES || attempt >= INITIAL_BOTTOM_MAX_SETTLE_FRAMES;
}

function hasRenderedTimelineBottom(scrollElement: HTMLElement, rowCount: number) {
  if (rowCount === 0) {
    return true;
  }
  return scrollElement.querySelector(`[data-index="${rowCount - 1}"]`) !== null;
}

function hasRenderedVirtualTimelineBottom(virtualItems: Array<{ index: number }>, rowCount: number) {
  if (rowCount === 0) {
    return true;
  }
  return virtualItems.some((virtualItem) => virtualItem.index === rowCount - 1);
}
