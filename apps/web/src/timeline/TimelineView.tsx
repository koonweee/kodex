import { Box, Button, Stack, Text } from "@mantine/core";
import { ArrowDownToLine } from "lucide-react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Virtuoso } from "react-virtuoso";

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
import { useTimelineScrollParent } from "./useTimelineScrollParent";
import { useBottomPinnedVirtuosoTimeline } from "./useBottomPinnedVirtuosoTimeline";

const EMPTY_APPROVALS: Approval[] = [];

const TIMELINE_TEXT = {
  beginningOfConversation: "Beginning of conversation",
  loadOlderHistory: "Load older history",
  loadingOlderHistory: "Loading older history",
  scrollToBottom: "Scroll to bottom",
};

type TimelineRenderRow = {
  key: string;
  row: TimelineRow;
};

type TimelineVirtualContext = {
  footer: ReactNode;
  header: ReactNode;
};

const TIMELINE_VIRTUOSO_COMPONENTS = {
  Footer: TimelineVirtualFooter,
  Header: TimelineVirtualHeader,
};

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
  const visibleDebugItems = showDebug ? timeline.hiddenItems.filter((item) => item.debugEvents.length > 0) : [];
  const [expandedWorkRowKeys, setExpandedWorkRowKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [showHistoryStart, setShowHistoryStart] = useState(false);
  useEffect(() => {
    setExpandedWorkRowKeys(new Set());
    setShowHistoryStart(false);
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
  const virtualPosition = useTimelineVirtualPosition(visibleRows, threadId);
  const virtuosoScrollParent = useTimelineScrollParent(scrollParentElement);
  const virtuosoInitialPositionProps = virtuosoScrollParent
    ? { initialTopMostItemIndex: { index: "LAST" as const, align: "end" as const } }
    : { initialItemCount: Math.min(rowCount, 30) };
  const handleLoadOlderHistory = useCallback(() => {
    setShowHistoryStart(true);
    onLoadOlderHistory?.();
  }, [onLoadOlderHistory]);
  const olderHistoryBoundary = timeline.hasOlderHistory ? (
    <OlderHistoryBoundary
      isLoading={timeline.isLoadingOlderHistory}
      onLoadOlderHistory={handleLoadOlderHistory}
    />
  ) : showHistoryStart ? <HistoryStartBoundary /> : null;
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
  usePrependAnchorCorrection({
    isLoadingOlderHistory: timeline.isLoadingOlderHistory,
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
          hiddenItems={visibleDebugItems}
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

  const virtualContext = {
    footer: (
      <>
        <HiddenDebugPanel
          hiddenItems={visibleDebugItems}
          imagePreviewUrlsByPath={imagePreviewUrlsByPath}
          onImageOpen={onImageOpen}
          onMarkdownOpen={onMarkdownOpen}
          threadId={threadId}
        />
        {unanchoredApprovals.length > 0 ? (
          <ThreadApprovalStack approvals={unanchoredApprovals} onDecision={onApprovalDecision} />
        ) : null}
      </>
    ),
    header: (
      <>
        {olderHistoryBoundary}
        <PendingRequestSummaryStack requests={pendingRequestSummaries} />
      </>
    ),
  };

  return (
    <Box className="kodex-timeline-virtual-root" data-initial-bottom-aligned={initialBottomAligned ? "true" : "false"}>
      <Virtuoso<TimelineRenderRow, TimelineVirtualContext>
        atBottomStateChange={handleAtBottomStateChange}
        atBottomThreshold={60}
        components={TIMELINE_VIRTUOSO_COMPONENTS}
        computeItemKey={(index, row) => row?.key ?? visibleRows[index - virtualPosition.firstItemIndex]?.key ?? index}
        context={virtualContext}
        customScrollParent={virtuosoScrollParent ?? undefined}
        data={visibleRows}
        defaultItemHeight={112}
        // The real scroll parent has one follow owner, including reading pauses.
        followOutput={virtuosoScrollParent ? false : followOutput}
        firstItemIndex={virtualPosition.firstItemIndex}
        increaseViewportBy={{ top: 720, bottom: 720 }}
        totalListHeightChanged={handleTotalListHeightChanged}
        {...virtuosoInitialPositionProps}
        itemContent={(index, renderRow = visibleRows[index - virtualPosition.firstItemIndex]) => renderRow ? (
          <Box className="kodex-timeline-virtual-row kodex-thread-column" data-index={index} data-row-key={renderRow.key}>
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
              toolbarTimestampMs={renderRow.row.type === "item" && isTimestampedMessage(renderRow.row.item) ? renderRow.row.item.timestampMs : undefined}
            />
          </Box>
        ) : null}
        key={virtualPosition.generation}
        ref={virtuosoRef}
      />
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

function HistoryStartBoundary() {
  return (
    <Box aria-label="Beginning of conversation" className="kodex-thread-column" component="section">
      <Button component="div" fullWidth size="xs" variant="subtle">
        {TIMELINE_TEXT.beginningOfConversation}
      </Button>
    </Box>
  );
}

const VIRTUOSO_INITIAL_FIRST_ITEM_INDEX = 1_000_000;

function useTimelineVirtualPosition(rows: TimelineRenderRow[], threadId?: string) {
  const firstKey = rows[0]?.key ?? null;
  const [position, setPosition] = useState(() => ({
    firstItemIndex: VIRTUOSO_INITIAL_FIRST_ITEM_INDEX,
    firstKey,
    generation: 0,
    threadId,
  }));

  if (position.threadId !== threadId) {
    const next = {
      firstItemIndex: VIRTUOSO_INITIAL_FIRST_ITEM_INDEX,
      firstKey,
      generation: position.generation + 1,
      threadId,
    };
    setPosition(next);
    return next;
  }
  if (position.firstKey !== firstKey) {
    const prependedRowCount = position.firstKey === null
      ? 0
      : rows.findIndex((row) => row.key === position.firstKey);
    const isPrepend = prependedRowCount > 0;
    const next = {
      firstItemIndex: isPrepend
        ? position.firstItemIndex - prependedRowCount
        : VIRTUOSO_INITIAL_FIRST_ITEM_INDEX,
      firstKey,
      generation: isPrepend ? position.generation : position.generation + 1,
      threadId,
    };
    // React restarts this render before commit, so a prepend reaches Virtuoso
    // with its matching logical index. Any other leading-row replacement gets
    // a fresh measurement generation instead of reusing an unrelated index.
    setPosition(next);
    return next;
  }
  return position;
}

function usePrependAnchorCorrection({
  isLoadingOlderHistory,
  scrollParentElement,
  timelineLastSeq,
}: {
  isLoadingOlderHistory: boolean;
  scrollParentElement: HTMLDivElement | null;
  timelineLastSeq: number;
}) {
  const anchorRef = useRef<{ key: string; offset: number } | null>(null);
  const wasLoadingRef = useRef(false);

  useLayoutEffect(() => {
    const scrollElement = scrollParentElement;
    if (!scrollElement) return;
    if (isLoadingOlderHistory) {
      wasLoadingRef.current = true;
      const captureAnchor = () => {
        const viewport = scrollElement.getBoundingClientRect();
        const row = [...scrollElement.querySelectorAll<HTMLElement>(".kodex-timeline-virtual-row")].find((candidate) => {
          const bounds = candidate.getBoundingClientRect();
          return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
        });
        if (row?.dataset.rowKey) {
          anchorRef.current = {
            key: row.dataset.rowKey,
            offset: row.getBoundingClientRect().top - viewport.top,
          };
        }
      };
      captureAnchor();
      scrollElement.addEventListener("scroll", captureAnchor, { passive: true });
      return () => scrollElement.removeEventListener("scroll", captureAnchor);
    }
    if (!wasLoadingRef.current) return;
    wasLoadingRef.current = false;

    const restoreAnchor = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const row = [...scrollElement.querySelectorAll<HTMLElement>(".kodex-timeline-virtual-row")]
        .find((candidate) => candidate.dataset.rowKey === anchor.key);
      if (!row) return;
      const currentOffset = row.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top;
      const correction = currentOffset - anchor.offset;
      if (Math.abs(correction) >= 0.5) scrollElement.scrollTop += correction;
    };

    let restoreFrame: number | null = null;
    const cancelRestore = () => {
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
      anchorRef.current = null;
      scrollElement.removeEventListener("wheel", cancelRestore);
      scrollElement.removeEventListener("touchstart", cancelRestore);
      scrollElement.removeEventListener("pointerdown", cancelRestore);
      document.removeEventListener("keydown", cancelRestore);
    };
    scrollElement.addEventListener("wheel", cancelRestore, { passive: true });
    scrollElement.addEventListener("touchstart", cancelRestore, { passive: true });
    scrollElement.addEventListener("pointerdown", cancelRestore);
    document.addEventListener("keydown", cancelRestore);

    let remainingPasses = 4;
    const restoreAfterMeasurement = () => {
      restoreAnchor();
      remainingPasses -= 1;
      if (remainingPasses > 0) {
        restoreFrame = requestAnimationFrame(restoreAfterMeasurement);
      } else {
        cancelRestore();
      }
    };
    restoreAfterMeasurement();
    return cancelRestore;
  }, [isLoadingOlderHistory, scrollParentElement, timelineLastSeq]);
}

function TimelineVirtualHeader({ context }: { context: TimelineVirtualContext }) {
  return context.header;
}

function TimelineVirtualFooter({ context }: { context: TimelineVirtualContext }) {
  return context.footer;
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
  toolbarTimestampMs,
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
  toolbarTimestampMs?: number;
}) {
  return (
    <Box className="kodex-turn-group" data-spacing={timelineRowSpacing(row)}>
      {row.type !== "work" && row.dividerBefore === "final_response" ? (
        <Box aria-hidden="true" className="kodex-timeline-final-response-divider" />
      ) : null}
      {row.type === "work" ? (
        <TimelineWorkRowRenderer
          expanded={isWorkExpanded}
          onExpandedChange={(expanded) => onWorkExpandedChange(row.key, expanded)}
          row={row}
        >
          <Stack gap={0} className="kodex-work-row-contents">
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
          toolbarTimestampMs={toolbarTimestampMs}
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

function timelineRowSpacing(row: TimelineRow): "compact" | undefined {
  return timelineRowOwnsDensity(row) ? "compact" : undefined;
}

function timelineRowOwnsDensity(row: TimelineRow): boolean {
  if (row.type === "activity" || row.type === "file_changes") {
    return true;
  }
  return row.type === "item" && row.item.kind === "context_compaction";
}

function isTimestampedMessage(item: TimelineItem): boolean {
  return item.kind === "user_message" || ((item.kind === "assistant_message" || item.kind === "agent_message") && item.messagePhase === "final_answer");
}

function buildTimelineRowApprovalMap(rows: TimelineRow[], approvalIndex: ReturnType<typeof buildApprovalIndex>) {
  const approvalsByRowKey = new Map<string, Approval[]>();
  if (approvalIndex.byItemId.size === 0) {
    return approvalsByRowKey;
  }
  for (const row of rows) {
    const rowApprovals = getTimelineRowApprovals(row, approvalIndex);
    if (rowApprovals.length > 0) {
      approvalsByRowKey.set(row.key, rowApprovals);
    }
  }
  return approvalsByRowKey;
}
