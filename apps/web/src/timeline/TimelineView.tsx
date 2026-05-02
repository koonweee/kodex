import { ActionIcon, Box, Stack, Tooltip } from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useEffect } from "react";

import type { Approval, ApprovalResponse } from "../api/client";
import { ApprovalCard, ThreadApprovalStack } from "../approvals/ApprovalCard";
import type { ImageLightboxImage } from "../images/types";
import {
  buildApprovalIndex,
  deriveTimelineRows,
  getTimelineRowApprovals,
  getUnanchoredApprovals,
  type TimelineRow,
} from "./derive";
import { TimelineActivityGroupRenderer, TimelineItemRenderer } from "./renderers";
import type { TimelineState } from "./reducer";

const EMPTY_APPROVALS: Approval[] = [];
const INITIAL_BOTTOM_STABLE_FRAMES = 2;
const INITIAL_BOTTOM_MAX_SETTLE_FRAMES = 90;
const BOTTOM_DISTANCE_EPSILON = 2;
const disableTimelineScrollAdjustment = () => false;

const TIMELINE_TEXT = {
  scrollToBottom: "Scroll to bottom",
};

export function TimelineView({
  approvals,
  imagePreviewUrlsByPath,
  onApprovalDecision,
  onImageOpen,
  onReady,
  scrollParentElement,
  showDebug,
  timeline,
}: {
  approvals: Approval[];
  imagePreviewUrlsByPath: Record<string, string>;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onReady: () => void;
  scrollParentElement: HTMLDivElement | null;
  showDebug: boolean;
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
    onReady,
    rows,
    scrollParentElement,
    timelineLastSeq: timeline.lastSeq,
  });

  if (rowCount === 0) {
    return approvals.length > 0 ? <ThreadApprovalStack approvals={approvals} onDecision={onApprovalDecision} /> : null;
  }

  const virtualItems = rowVirtualizer.getVirtualItems();
  const renderedVirtualItems =
    virtualItems.length > 0 ? virtualItems : fallbackVirtualItems(rows, isNearBottom);

  return (
    <Box className="kodex-timeline-virtual-root" data-initial-bottom-aligned={initialBottomAligned ? "true" : "false"}>
      {unanchoredApprovals.length > 0 ? (
        <ThreadApprovalStack approvals={unanchoredApprovals} onDecision={onApprovalDecision} />
      ) : null}
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
                row={row}
                showDebug={showDebug}
              />
            </Box>
          );
        })}
      </Box>
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

function useBottomPinnedVirtualTimeline({
  onReady,
  rows,
  scrollParentElement,
  timelineLastSeq,
}: {
  onReady: () => void;
  rows: TimelineRow[];
  scrollParentElement: HTMLDivElement | null;
  timelineLastSeq: number;
}) {
  const rowCount = rows.length;
  const lastRowKey = rows[rowCount - 1]?.key ?? "";
  const nearBottomRef = useRef(true);
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
      setShowScrollToBottom(false);
      return true;
    }
    const distanceFromBottom = getDistanceFromBottom(scrollElement);
    const isNearBottom = distanceFromBottom < 96;
    nearBottomRef.current = isNearBottom;
    setShowScrollToBottom(!isNearBottom && rowCount > 0 && distanceFromBottom > 0);
    return isNearBottom;
  }, [rowCount, scrollParentElement]);

  const scrollToTimelineBottom = useCallback(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      return;
    }
    rowVirtualizer.scrollToIndex(Math.max(0, rowCount - 1), { align: "end" });
    scrollElement.scrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  }, [rowCount, rowVirtualizer, scrollParentElement]);

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
    nearBottomRef.current = true;
    setShowScrollToBottom(false);

    scrollToTimelineBottom();
    requestAnimationFrame(() => {
      if (nearBottomRef.current) {
        scrollToTimelineBottom();
      }
      updateNearBottom();
    });
  }, [scrollToTimelineBottom, updateNearBottom]);

  useEffect(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      return;
    }

    updateNearBottom();
    scrollElement.addEventListener("scroll", updateNearBottom, { passive: true });
    return () => scrollElement.removeEventListener("scroll", updateNearBottom);
  }, [scrollParentElement, updateNearBottom]);

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
    const settleBottom = (attempt: number, stableFrames: number, previousScrollHeight: number) => {
      if (!nearBottomRef.current) {
        markTimelineReady();
        return;
      }

      scrollToTimelineBottom();
      const frameId = requestAnimationFrame(() => {
        const scrollElement = scrollParentElement;
        const scrollHeight = scrollElement?.scrollHeight ?? 0;
        const nextStableFrames = isSettledAtBottom(scrollElement, previousScrollHeight, rowCount) ? stableFrames + 1 : 0;

        if (nextStableFrames >= INITIAL_BOTTOM_STABLE_FRAMES || attempt >= INITIAL_BOTTOM_MAX_SETTLE_FRAMES) {
          finishInitialBottomReveal();
          return;
        }

        settleBottom(attempt + 1, nextStableFrames, scrollHeight);
      });
      frameIds.push(frameId);
    };

    settleBottom(0, 0, -1);
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

    if (nearBottomRef.current) {
      scrollToTimelineBottom();
      const frameId = requestAnimationFrame(() => {
        if (nearBottomRef.current) {
          scrollToTimelineBottom();
        }
        updateNearBottom();
      });
      return () => cancelAnimationFrame(frameId);
    }

    setShowScrollToBottom(true);
  }, [
    initialBottomAligned,
    lastRowKey,
    rowCount,
    scrollToTimelineBottom,
    timelineLastSeq,
    updateNearBottom,
  ]);

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
  row,
  showDebug,
}: {
  approvals: Approval[];
  imagePreviewUrlsByPath: Record<string, string>;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  row: TimelineRow;
  showDebug: boolean;
}) {
  return (
    <Box className="kodex-turn-group">
      {row.dividerBefore === "final_response" ? <Box aria-hidden="true" className="kodex-timeline-final-response-divider" /> : null}
      {row.type === "activity" ? (
        <TimelineActivityGroupRenderer items={row.items} onImageOpen={onImageOpen} showDebug={showDebug} />
      ) : (
        <TimelineItemRenderer
          item={row.item}
          imagePreviewUrlsByPath={imagePreviewUrlsByPath}
          onImageOpen={onImageOpen}
          showDebug={showDebug}
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

function isSettledAtBottom(scrollElement: HTMLElement | null, previousScrollHeight: number, rowCount: number) {
  if (!scrollElement) {
    return true;
  }
  return (
    scrollElement.scrollHeight === previousScrollHeight &&
    hasRenderedTimelineBottom(scrollElement, rowCount) &&
    Math.abs(getDistanceFromBottom(scrollElement)) < BOTTOM_DISTANCE_EPSILON
  );
}

function hasRenderedTimelineBottom(scrollElement: HTMLElement, rowCount: number) {
  if (rowCount === 0) {
    return true;
  }
  return scrollElement.querySelector(`[data-index="${rowCount - 1}"]`) !== null;
}
