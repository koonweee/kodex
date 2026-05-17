import { ActionIcon, Box, Stack, Text, Tooltip } from "@mantine/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, useEffect } from "react";

import type { Approval, ApprovalResponse, PendingTimelineRequestSummary } from "../api/client";
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
import type { TimelineItem, TimelineState } from "./reducer";

const EMPTY_APPROVALS: Approval[] = [];
const INITIAL_BOTTOM_STABLE_FRAMES = 3;
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
  onMarkdownOpen,
  onReady,
  scrollParentElement,
  showDebug,
  threadId,
  timeline,
}: {
  approvals: Approval[];
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
  const messageTimestamps = useMemo(() => visibleMessageTimestamps(rows), [rows]);
  const approvalIndex = useMemo(() => buildApprovalIndex(approvals), [approvals]);
  const pendingRequestSummaries = useMemo(
    () => pendingTimelineRequestSummaries(timeline, approvals),
    [approvals, timeline],
  );
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
        <PendingRequestSummaryStack requests={pendingRequestSummaries} />
      </>
    );
  }

  const virtualItems = rowVirtualizer.getVirtualItems();
  const renderedVirtualItems =
    virtualItems.length > 0 ? virtualItems : fallbackVirtualItems(rows, isNearBottom);

  return (
    <Box className="kodex-timeline-virtual-root" data-initial-bottom-aligned={initialBottomAligned ? "true" : "false"}>
      <PendingRequestSummaryStack requests={pendingRequestSummaries} />
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
                toolbarTimestamps={messageTimestamps}
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

function pendingTimelineRequestSummaries(
  timeline: TimelineState,
  approvals: Approval[],
): PendingTimelineRequestSummary[] {
  const renderedApprovalIds = new Set(approvals.map((approval) => approval.id));
  return [...(timeline.pendingApprovalRequests ?? []), ...(timeline.pendingUserInputRequests ?? [])].filter(
    (request) => !renderedApprovalIds.has(request.id),
  );
}

function PendingRequestSummaryStack({ requests }: { requests: PendingTimelineRequestSummary[] }) {
  if (requests.length === 0) {
    return null;
  }
  return (
    <Stack gap="xs" className="kodex-thread-approvals kodex-main-column">
      {requests.map((request) => (
        <Box className="kodex-approval-card" key={request.id}>
          <Text fw={600} size="sm">
            {request.title}
          </Text>
          {request.summary ? (
            <Text c="dimmed" size="sm">
              {request.summary}
            </Text>
          ) : null}
        </Box>
      ))}
    </Stack>
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
    const isNearBottom = distanceFromBottom < 60;
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
  onMarkdownOpen,
  row,
  showDebug,
  threadId,
  toolbarTimestamps,
}: {
  approvals: Approval[];
  imagePreviewUrlsByPath: Record<string, string>;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  row: TimelineRow;
  showDebug: boolean;
  threadId?: string;
  toolbarTimestamps: Map<string, number>;
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
          toolbarTimestampMs={toolbarTimestamps.get(row.item.id)}
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

function visibleMessageTimestamps(rows: TimelineRow[]): Map<string, number> {
  const timestamps = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== "item") {
      continue;
    }
    if (!isTimestampedMessage(row.item) || row.item.timestampMs === undefined) {
      continue;
    }
    timestamps.set(row.item.id, row.item.timestampMs);
  }
  return timestamps;
}

function isTimestampedMessage(item: TimelineItem): boolean {
  return item.kind === "user_message" || ((item.kind === "assistant_message" || item.kind === "agent_message") && item.messagePhase === "final_answer");
}

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
