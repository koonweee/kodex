import { Box, Button, Stack, Text } from "@mantine/core";
import { ArrowDownToLine } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type FollowOutput, type VirtuosoHandle } from "react-virtuoso";

import type { Approval, ApprovalResponse, PendingTimelineRequestSummary } from "../api/client";
import type { MarkdownPreviewRequest } from "../files/types";
import { ApprovalCard, ThreadApprovalStack } from "../approvals/ApprovalCard";
import type { ImageLightboxImage } from "../images/types";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import {
  buildApprovalIndex,
  getTimelineRowApprovals,
  getUnanchoredApprovals,
} from "./derive";
import { TimelineActivityGroupRenderer, TimelineFileChangesRenderer, TimelineItemRenderer, TimelineWorkRowRenderer } from "./renderers";
import type { TimelineItem, TimelineRow, TimelineState } from "./reducer";

const EMPTY_APPROVALS: Approval[] = [];

const TIMELINE_TEXT = {
  loadOlderHistory: "Load older history",
  loadingOlderHistory: "Loading older history",
  scrollToBottom: "Scroll to bottom",
};

type TimelineRenderRow = {
  key: string;
  row: TimelineRow;
};

type TimelineScrollBehavior = "auto" | "smooth";

export function timelineFollowOutputBehavior(isNearBottom: boolean): ReturnType<Exclude<FollowOutput, boolean | string>> {
  return isNearBottom ? "auto" : false;
}

export function TimelineView({
  approvals,
  imagePreviewUrlsByPath,
  onApprovalDecision,
  onImageOpen,
  onLoadOlderHistory,
  onMarkdownOpen,
  onOverflowAboveChange,
  onOverflowBelowChange,
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
  onLoadOlderHistory?: () => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  onOverflowAboveChange?: (hasOverflowAbove: boolean) => void;
  onOverflowBelowChange?: (hasOverflowBelow: boolean) => void;
  onReady: () => void;
  scrollParentElement: HTMLDivElement | null;
  showDebug: boolean;
  threadId?: string;
  timeline: TimelineState;
}) {
  const rows = timeline.rows;
  const [expandedWorkRowKeys, setExpandedWorkRowKeys] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setExpandedWorkRowKeys(new Set());
  }, [threadId]);
  useEffect(() => {
    const expandableWorkRowKeys = new Set(
      rows.filter((row) => row.type === "work" && row.collapsedRows.length > 0).map((row) => row.key),
    );
    setExpandedWorkRowKeys((current) => {
      let changed = false;
      const next = new Set<string>();
      for (const key of current) {
        if (expandableWorkRowKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [rows]);
  const handleWorkRowExpandedChange = useCallback((rowKey: string, expanded: boolean) => {
    setExpandedWorkRowKeys((current) => {
      const currentlyExpanded = current.has(rowKey);
      if (currentlyExpanded === expanded) {
        return current;
      }
      const next = new Set(current);
      if (expanded) {
        next.add(rowKey);
      } else {
        next.delete(rowKey);
      }
      return next;
    });
  }, []);
  const visibleRows = useMemo(() => rows.map((row) => ({ key: row.key, row })), [rows]);
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
  const rowCount = visibleRows.length;
  const virtuosoScrollParent = scrollParentElement && scrollParentElement.clientHeight > 0 ? scrollParentElement : null;
  const virtuosoInitialPositionProps = virtuosoScrollParent
    ? { initialTopMostItemIndex: { index: "LAST" as const, align: "end" as const } }
    : { initialItemCount: Math.min(rowCount, 30) };
  const olderHistoryBoundary = timeline.hasOlderHistory ? (
    <OlderHistoryBoundary
      isLoading={timeline.isLoadingOlderHistory}
      onLoadOlderHistory={onLoadOlderHistory}
    />
  ) : null;
  usePrependScrollRestoration({
    isLoadingOlderHistory: timeline.isLoadingOlderHistory,
    rowCount,
    scrollParentElement,
    threadId,
  });
  const {
    followOutput,
    handleAtBottomStateChange,
    handleTotalListHeightChanged,
    initialBottomAligned,
    scrollToBottom,
    showScrollToBottom,
    virtuosoRef,
  } = useBottomPinnedVirtuosoTimeline({
    onReady,
    onOverflowAboveChange,
    rowCount,
    scrollParentElement,
    timelineLastSeq: timeline.lastSeq,
  });
  useEffect(() => {
    onOverflowBelowChange?.(showScrollToBottom);
    return () => onOverflowBelowChange?.(false);
  }, [onOverflowBelowChange, showScrollToBottom]);

  if (rowCount === 0) {
    return (
      <>
        {olderHistoryBoundary}
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

  return (
    <Box className="kodex-timeline-virtual-root" data-initial-bottom-aligned={initialBottomAligned ? "true" : "false"}>
      {olderHistoryBoundary}
      <PendingRequestSummaryStack requests={pendingRequestSummaries} />
      <Virtuoso<TimelineRenderRow>
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={60}
        computeItemKey={(index, row) => row?.key ?? visibleRows[index]?.key ?? index}
        customScrollParent={virtuosoScrollParent ?? undefined}
        data={visibleRows}
        defaultItemHeight={112}
        followOutput={followOutput}
        increaseViewportBy={{ top: 720, bottom: 720 }}
        totalListHeightChanged={handleTotalListHeightChanged}
        {...virtuosoInitialPositionProps}
        itemContent={(index, renderRow = visibleRows[index]) => renderRow ? (
          <Box className="kodex-timeline-virtual-row kodex-thread-column" data-index={index}>
            <TimelineRowView
              approvals={approvalsByRowKey.get(renderRow.row.key) ?? EMPTY_APPROVALS}
              imagePreviewUrlsByPath={imagePreviewUrlsByPath}
              isWorkExpanded={
                renderRow.row.type === "work" ? expandedWorkRowKeys.has(renderRow.row.key) : false
              }
              onApprovalDecision={onApprovalDecision}
              onWorkExpandedChange={handleWorkRowExpandedChange}
              onImageOpen={onImageOpen}
              onMarkdownOpen={onMarkdownOpen}
              row={renderRow.row}
              showDebug={showDebug}
              threadId={threadId}
              toolbarTimestamps={messageTimestamps}
            />
          </Box>
        ) : null}
        ref={virtuosoRef}
      />
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
        <AdaptiveIconButton
          className="kodex-scroll-to-bottom"
          color="gray"
          label={TIMELINE_TEXT.scrollToBottom}
          onClick={scrollToBottom}
          shape="round"
          variant="light"
        >
          <ArrowDownToLine />
        </AdaptiveIconButton>
      ) : null}
    </Box>
  );
}

function OlderHistoryBoundary({
  isLoading,
  onLoadOlderHistory,
}: {
  isLoading: boolean;
  onLoadOlderHistory?: () => void;
}) {
  const label = isLoading ? TIMELINE_TEXT.loadingOlderHistory : TIMELINE_TEXT.loadOlderHistory;
  return (
    <Box
      aria-busy={isLoading ? "true" : undefined}
      aria-label="Older history boundary"
      className="kodex-thread-column"
      component="section"
    >
      <Button
        disabled={isLoading || !onLoadOlderHistory}
        fullWidth
        loading={isLoading}
        onClick={isLoading ? undefined : onLoadOlderHistory}
        size="xs"
        variant="subtle"
      >
        {label}
      </Button>
    </Box>
  );
}

function usePrependScrollRestoration({
  isLoadingOlderHistory,
  rowCount,
  scrollParentElement,
  threadId,
}: {
  isLoadingOlderHistory: boolean;
  rowCount: number;
  scrollParentElement: HTMLDivElement | null;
  threadId?: string;
}) {
  const pendingAnchor = useRef<{ rowCount: number; scrollHeight: number; scrollTop: number } | null>(null);
  const lastThreadId = useRef(threadId);

  useLayoutEffect(() => {
    if (lastThreadId.current !== threadId) {
      lastThreadId.current = threadId;
      pendingAnchor.current = null;
    }
    const scrollElement = scrollParentElement;
    if (!scrollElement || !isLoadingOlderHistory || pendingAnchor.current) {
      return;
    }
    pendingAnchor.current = {
      rowCount,
      scrollHeight: scrollElement.scrollHeight,
      scrollTop: scrollElement.scrollTop,
    };
  }, [isLoadingOlderHistory, rowCount, scrollParentElement, threadId]);

  useLayoutEffect(() => {
    const scrollElement = scrollParentElement;
    const anchor = pendingAnchor.current;
    if (!scrollElement || !anchor || isLoadingOlderHistory) {
      return;
    }
    if (rowCount > anchor.rowCount) {
      const heightDelta = scrollElement.scrollHeight - anchor.scrollHeight;
      if (heightDelta > 0) {
        scrollElement.scrollTop = anchor.scrollTop + heightDelta;
      }
    }
    pendingAnchor.current = null;
  }, [isLoadingOlderHistory, rowCount, scrollParentElement]);
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
    <Stack gap="xs" className="kodex-thread-approvals kodex-thread-column">
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
    <Box className="kodex-hidden-debug-panel kodex-thread-column">
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

function useBottomPinnedVirtuosoTimeline({
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
  const initialAlignmentSnapshotRef = useRef<{ rowCount: number; timelineLastSeq: number } | null>(null);
  const pendingBottomFollowFrame = useRef<number | null>(null);
  const showScrollToBottomRef = useRef(false);
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

  const updateOverflowAbove = useCallback(() => {
    const scrollElement = scrollParentElement;
    const hasOverflowAbove = Boolean(scrollElement && rowCount > 0 && scrollElement.scrollTop > 8);
    onOverflowAboveChange?.(hasOverflowAbove);
    return hasOverflowAbove;
  }, [onOverflowAboveChange, rowCount, scrollParentElement]);

  const updateNearBottom = useCallback(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      isPinnedToBottomRef.current = true;
      setScrollToBottomVisible(false);
      onOverflowAboveChange?.(false);
      return true;
    }
    const distanceFromBottom = getDistanceFromBottom(scrollElement);
    const isNearBottom = distanceFromBottom < 60;
    isPinnedToBottomRef.current = isNearBottom;
    if (!isNearBottom) {
      cancelPendingBottomFollow();
    }
    setScrollToBottomVisible(!isNearBottom && rowCount > 0 && distanceFromBottom > 0);
    updateOverflowAbove();
    return isNearBottom;
  }, [cancelPendingBottomFollow, onOverflowAboveChange, rowCount, scrollParentElement, setScrollToBottomVisible, updateOverflowAbove]);

  const scrollToTimelineBottom = useCallback((behavior: TimelineScrollBehavior = "auto") => {
    if (rowCount === 0) {
      return;
    }
    if (scrollParentElement) {
      const top = scrollParentElement.scrollHeight - scrollParentElement.clientHeight;
      if (top > 0) {
        if (behavior === "smooth" && typeof scrollParentElement.scrollTo === "function") {
          scrollParentElement.scrollTo({ top, behavior });
        } else {
          scrollParentElement.scrollTop = top;
        }
      }
    }
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior });
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
        scrollToTimelineBottom(behavior);
        pendingBottomFollowFrame.current = requestAnimationFrame(() => {
          pendingBottomFollowFrame.current = null;
          if (!isPinnedToBottomRef.current && behavior === "auto") {
            return;
          }
          scrollToTimelineBottom(behavior);
          if (behavior === "auto") {
            updateNearBottom();
          }
        });
      });
    },
    [rowCount, scrollToTimelineBottom, updateNearBottom],
  );

  const markTimelineReady = useCallback(() => {
    setInitialBottomAligned(true);
    onReady();
  }, [onReady]);

  const scrollToBottom = useCallback(() => {
    isPinnedToBottomRef.current = true;
    setScrollToBottomVisible(false);
    cancelPendingBottomFollow();
    scrollToTimelineBottom("smooth");
    requestAnimationFrame(() => {
      scrollToTimelineBottom("smooth");
      updateNearBottom();
    });
  }, [cancelPendingBottomFollow, scrollToTimelineBottom, setScrollToBottomVisible, updateNearBottom]);

  const handleAtBottomStateChange = useCallback(
    (atBottom: boolean) => {
      isPinnedToBottomRef.current = atBottom;
      if (!atBottom) {
        cancelPendingBottomFollow();
      }
      setScrollToBottomVisible(!atBottom && rowCount > 0);
    },
    [cancelPendingBottomFollow, rowCount, setScrollToBottomVisible],
  );

  const handleTotalListHeightChanged = useCallback(() => {
    if (rowCount === 0 || showScrollToBottomRef.current || !isPinnedToBottomRef.current) {
      return;
    }
    scheduleBottomFollow("auto");
  }, [rowCount, scheduleBottomFollow]);

  useEffect(() => cancelPendingBottomFollow, [cancelPendingBottomFollow]);

  const followOutput = useCallback<Exclude<FollowOutput, boolean | string>>(
    (isAtBottom) => timelineFollowOutputBehavior(isAtBottom || (isPinnedToBottomRef.current && !showScrollToBottomRef.current)),
    [],
  );

  useEffect(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      return;
    }

    updateNearBottom();
    scrollElement.addEventListener("scroll", updateNearBottom, { passive: true });
    return () => {
      scrollElement.removeEventListener("scroll", updateNearBottom);
      onOverflowAboveChange?.(false);
    };
  }, [onOverflowAboveChange, scrollParentElement, updateNearBottom]);

  useEffect(() => {
    if (initialBottomAligned) {
      return;
    }

    if (rowCount === 0) {
      isPinnedToBottomRef.current = true;
      setScrollToBottomVisible(false);
      initialAlignmentSnapshotRef.current = { rowCount, timelineLastSeq };
      markTimelineReady();
      return;
    }

    if (!isPinnedToBottomRef.current) {
      setScrollToBottomVisible(true);
      initialAlignmentSnapshotRef.current = { rowCount, timelineLastSeq };
      markTimelineReady();
      return;
    }

    scheduleBottomFollow("auto");
    let readyFrameId: number | null = null;
    const frameId = requestAnimationFrame(() => {
      initialAlignmentSnapshotRef.current = { rowCount, timelineLastSeq };
      updateNearBottom();
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
    timelineLastSeq,
    updateNearBottom,
  ]);

  useEffect(() => {
    if (!initialBottomAligned || rowCount === 0) {
      return;
    }

    const initialAlignmentSnapshot = initialAlignmentSnapshotRef.current;
    if (
      initialAlignmentSnapshot?.rowCount === rowCount &&
      initialAlignmentSnapshot.timelineLastSeq === timelineLastSeq
    ) {
      return;
    }

    if (showScrollToBottom) {
      isPinnedToBottomRef.current = false;
      return;
    }

    if (isPinnedToBottomRef.current) {
      scheduleBottomFollow("auto");
      return;
    }

    setScrollToBottomVisible(true);
  }, [
    initialBottomAligned,
    rowCount,
    scheduleBottomFollow,
    setScrollToBottomVisible,
    showScrollToBottom,
    timelineLastSeq,
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

const TimelineRowView = memo(function TimelineRowView({
  approvals,
  imagePreviewUrlsByPath,
  isWorkExpanded,
  onApprovalDecision,
  onImageOpen,
  onMarkdownOpen,
  onWorkExpandedChange,
  row,
  showDebug,
  threadId,
  toolbarTimestamps,
}: {
  approvals: Approval[];
  imagePreviewUrlsByPath: Record<string, string>;
  isWorkExpanded: boolean;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  onWorkExpandedChange: (rowKey: string, expanded: boolean) => void;
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
          expanded={isWorkExpanded}
          onExpandedChange={(expanded) => onWorkExpandedChange(row.key, expanded)}
          row={row}
        >
          <Stack gap={8} mt={8}>
            {row.collapsedRows.map((collapsedRow) => (
              <TimelineRowView
                approvals={[]}
                imagePreviewUrlsByPath={imagePreviewUrlsByPath}
                isWorkExpanded={false}
                key={collapsedRow.key}
                onApprovalDecision={onApprovalDecision}
                onWorkExpandedChange={onWorkExpandedChange}
                onImageOpen={onImageOpen}
                onMarkdownOpen={onMarkdownOpen}
                row={collapsedRow}
                showDebug={showDebug}
                threadId={threadId}
                toolbarTimestamps={toolbarTimestamps}
              />
            ))}
          </Stack>
        </TimelineWorkRowRenderer>
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
        <TimelineFileChangesRenderer entries={row.entries} showDebug={showDebug} />
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
