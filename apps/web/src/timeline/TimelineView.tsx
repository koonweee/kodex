import { ActionIcon, Box, Button, Stack, Text, Tooltip } from "@mantine/core";
import { ArrowDownToLine } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtuoso, type FollowOutput, type VirtuosoHandle } from "react-virtuoso";

import type { Approval, ApprovalResponse, PendingTimelineRequestSummary } from "../api/client";
import type { MarkdownPreviewRequest } from "../files/types";
import { ApprovalCard, ThreadApprovalStack } from "../approvals/ApprovalCard";
import type { ImageLightboxImage } from "../images/types";
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
    initialBottomAligned,
    scrollToBottom,
    showScrollToBottom,
    virtuosoRef,
  } = useBottomPinnedVirtuosoTimeline({
    onReady,
    rowCount,
    scrollParentElement,
    timelineLastSeq: timeline.lastSeq,
  });

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
        initialItemCount={virtuosoScrollParent ? undefined : rowCount}
        itemContent={(index, renderRow = visibleRows[index]) => renderRow ? (
          <Box className="kodex-timeline-virtual-row kodex-main-column" data-index={index}>
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
        {...(virtuosoScrollParent ? { initialTopMostItemIndex: { index: rowCount - 1, align: "end" } as const } : {})}
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
      className="kodex-main-column"
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

function useBottomPinnedVirtuosoTimeline({
  onReady,
  rowCount,
  scrollParentElement,
  timelineLastSeq,
}: {
  onReady: () => void;
  rowCount: number;
  scrollParentElement: HTMLDivElement | null;
  timelineLastSeq: number;
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const nearBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [initialBottomAligned, setInitialBottomAligned] = useState(false);

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
    if (rowCount === 0) {
      return;
    }
    if (scrollParentElement) {
      const top = scrollParentElement.scrollHeight - scrollParentElement.clientHeight;
      if (top > 0) {
        if (typeof scrollParentElement.scrollTo === "function") {
          scrollParentElement.scrollTo({ top, behavior: "auto" });
        } else {
          scrollParentElement.scrollTop = top;
        }
      }
    }
    virtuosoRef.current?.scrollToIndex({ index: "LAST", align: "end", behavior: "auto" });
  }, [rowCount, scrollParentElement]);

  const markTimelineReady = useCallback(() => {
    setInitialBottomAligned(true);
    onReady();
  }, [onReady]);

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

  const handleAtBottomStateChange = useCallback(
    (atBottom: boolean) => {
      nearBottomRef.current = atBottom;
      setShowScrollToBottom(!atBottom && rowCount > 0);
    },
    [rowCount],
  );

  const followOutput = useCallback<Exclude<FollowOutput, boolean | string>>(
    (isAtBottom) => timelineFollowOutputBehavior(isAtBottom || nearBottomRef.current),
    [],
  );

  useEffect(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) {
      return;
    }

    updateNearBottom();
    scrollElement.addEventListener("scroll", updateNearBottom, { passive: true });
    return () => scrollElement.removeEventListener("scroll", updateNearBottom);
  }, [scrollParentElement, updateNearBottom]);

  useEffect(() => {
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

    const frameId = requestAnimationFrame(() => {
      scrollToTimelineBottom();
      updateNearBottom();
      markTimelineReady();
    });
    return () => cancelAnimationFrame(frameId);
  }, [
    initialBottomAligned,
    markTimelineReady,
    rowCount,
    scrollToTimelineBottom,
    updateNearBottom,
  ]);

  useEffect(() => {
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
    rowCount,
    scrollToTimelineBottom,
    timelineLastSeq,
    updateNearBottom,
  ]);

  return {
    followOutput,
    handleAtBottomStateChange,
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
