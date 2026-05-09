import { ActionIcon, Badge, Box, Button, Group, Menu, Skeleton, Title, Tooltip } from "@mantine/core";
import { AlertCircle, Archive, Bot, MoreHorizontal, PanelLeftOpen, PanelRightOpen, Pin, PinOff } from "lucide-react";
import type { ReactNode } from "react";

import type { Approval, ApprovalResponse, ThreadSummary } from "../api/client";
import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import { EmptyPanel } from "../ui/EmptyPanel";
import { TimelineView } from "../timeline/TimelineView";
import type { TimelineEntry } from "../timeline/entry";
import type { TimelineState } from "../timeline/reducer";

const THREAD_PANEL_TEXT = {
  actions: "Thread actions",
  archive: "Archive thread",
  browseThreads: "Browse threads",
  pin: "Pin thread",
  showSidebar: "Show sidebar",
  threadUnavailableText: "This thread could not be loaded. It may have been archived, deleted, or unavailable from this gateway.",
  threadUnavailableTitle: "Thread not found or unavailable",
  threadTimelineText: "Select or create a thread to view events, messages, tool calls, and warnings.",
  threadTimelineTitle: "Thread timeline",
  unpin: "Unpin thread",
};

export function ThreadPanel({
  errorMessage,
  imagePreviewUrlsByPath,
  isDraftThreadSelected,
  isSelectedTimelineLoading,
  onArchiveThread,
  onApprovalDecision,
  onImageOpen,
  onMarkdownOpen,
  onPinThread,
  onShowMobileSidebar,
  onSubagentSidebarToggle,
  onTimelineReady,
  onUnpinThread,
  pendingTitleThreadIds,
  scrollParentElement,
  selectedThread,
  selectedThreadUnavailableId,
  selectedThreadApprovals,
  selectedThreadTitle,
  selectedTimelineEntry,
  setTimelineScrollElement,
  showDebugEvents,
  subagentSidebarOpen,
  subagentToggleVisible,
  subagentViewer,
  timeline,
}: {
  errorMessage: string | null;
  imagePreviewUrlsByPath: Record<string, string>;
  isDraftThreadSelected: boolean;
  isSelectedTimelineLoading: boolean;
  onArchiveThread: () => void;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  onPinThread: (threadId: string) => void;
  onShowMobileSidebar: () => void;
  onSubagentSidebarToggle?: () => void;
  onTimelineReady: () => void;
  onUnpinThread: (threadId: string) => void;
  pendingTitleThreadIds: Set<string>;
  scrollParentElement: HTMLDivElement | null;
  selectedThread: ThreadSummary | null;
  selectedThreadUnavailableId?: string | null;
  selectedThreadApprovals: Approval[];
  selectedThreadTitle: string;
  selectedTimelineEntry: TimelineEntry;
  setTimelineScrollElement: (element: HTMLDivElement | null) => void;
  showDebugEvents: boolean;
  subagentSidebarOpen?: boolean;
  subagentToggleVisible?: boolean;
  subagentViewer?: ReactNode;
  timeline: TimelineState;
}) {
  const selectedThreadTitleIsPending = selectedThread ? pendingTitleThreadIds.has(selectedThread.id) : false;
  const shouldShowThreadTitle = selectedThread !== null && !selectedThreadTitleIsPending;
  const shouldShowThreadPane = selectedThread !== null || isSelectedTimelineLoading || isDraftThreadSelected;

  return (
    <>
      {errorMessage ? (
        <Badge
          className="kodex-main-column"
          data-tone="danger"
          variant="light"
          leftSection={<AlertCircle size={12} />}
        >
          {errorMessage}
        </Badge>
      ) : null}
      {selectedThreadUnavailableId && !selectedThread ? (
        <>
          <ThreadHeader
            onShowMobileSidebar={onShowMobileSidebar}
            title={THREAD_PANEL_TEXT.threadUnavailableTitle}
          />
          <Box className="kodex-thread-empty kodex-main-column">
            <EmptyPanel
              icon={<AlertCircle size={22} />}
              title={THREAD_PANEL_TEXT.threadUnavailableTitle}
              text={THREAD_PANEL_TEXT.threadUnavailableText}
            />
            <Group className="kodex-thread-empty-actions" justify="center" gap="xs" wrap="nowrap">
              <Button
                className="kodex-thread-empty-action"
                onClick={onShowMobileSidebar}
                size="compact-sm"
                type="button"
                variant="light"
              >
                {THREAD_PANEL_TEXT.browseThreads}
              </Button>
            </Group>
          </Box>
        </>
      ) : shouldShowThreadPane ? (
        <>
          <ThreadHeader
            onShowMobileSidebar={onShowMobileSidebar}
            title={shouldShowThreadTitle ? selectedThreadTitle : null}
          >
            {selectedThread ? (
              <Group gap={4} wrap="nowrap">
                {subagentToggleVisible && onSubagentSidebarToggle ? (
                  <Tooltip label={subagentSidebarOpen ? "Hide subagents" : "Show subagents"}>
                    <ActionIcon
                      aria-label={subagentSidebarOpen ? "Hide subagents" : "Show subagents"}
                      aria-pressed={subagentSidebarOpen ? "true" : "false"}
                      onClick={onSubagentSidebarToggle}
                      variant={subagentSidebarOpen ? "light" : "subtle"}
                    >
                      <Bot size={17} />
                    </ActionIcon>
                  </Tooltip>
                ) : null}
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target>
                    <ActionIcon aria-label={THREAD_PANEL_TEXT.actions} variant="subtle">
                      <MoreHorizontal size={17} />
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item
                      leftSection={selectedThread.pinnedAt ? <PinOff size={14} /> : <Pin size={14} />}
                      onClick={() => {
                        if (selectedThread.pinnedAt) {
                          onUnpinThread(selectedThread.id);
                          return;
                        }
                        onPinThread(selectedThread.id);
                      }}
                    >
                      {selectedThread.pinnedAt ? THREAD_PANEL_TEXT.unpin : THREAD_PANEL_TEXT.pin}
                    </Menu.Item>
                    <Menu.Item leftSection={<Archive size={14} />} onClick={onArchiveThread}>
                      {THREAD_PANEL_TEXT.archive}
                    </Menu.Item>
                  </Menu.Dropdown>
                </Menu>
              </Group>
            ) : null}
          </ThreadHeader>
          {selectedThread || isSelectedTimelineLoading ? (
            <Box className="kodex-thread-content" data-subagent-sidebar={subagentViewer ? "open" : "closed"}>
              <Box
                className="kodex-timeline-scroll"
                data-entry-phase={selectedTimelineEntry.phase}
                ref={setTimelineScrollElement}
              >
                {isSelectedTimelineLoading ? (
                  <TimelineLoadingSkeleton />
                ) : selectedThread ? (
                  <TimelineView
                    key={selectedThread.id}
                    approvals={selectedThreadApprovals}
                    onReady={onTimelineReady}
                    onApprovalDecision={onApprovalDecision}
                    onImageOpen={onImageOpen}
                    onMarkdownOpen={onMarkdownOpen}
                    imagePreviewUrlsByPath={imagePreviewUrlsByPath}
                    scrollParentElement={scrollParentElement}
                    showDebug={showDebugEvents}
                    threadId={selectedThread.id}
                    timeline={timeline}
                  />
                ) : null}
              </Box>
              {subagentViewer}
            </Box>
          ) : null}
        </>
      ) : (
        <>
          <ThreadHeader
            onShowMobileSidebar={onShowMobileSidebar}
            title={THREAD_PANEL_TEXT.threadTimelineTitle}
          />
          <Box className="kodex-thread-empty kodex-main-column">
            <EmptyPanel
              icon={<PanelRightOpen size={22} />}
              title="No thread selected"
              text={THREAD_PANEL_TEXT.threadTimelineText}
            />
            <Group className="kodex-thread-empty-actions" justify="center" gap="xs" wrap="nowrap">
              <Button
                className="kodex-thread-empty-action"
                onClick={onShowMobileSidebar}
                size="compact-sm"
                type="button"
                variant="light"
              >
                {THREAD_PANEL_TEXT.browseThreads}
              </Button>
            </Group>
          </Box>
        </>
      )}
    </>
  );
}

function TimelineLoadingSkeleton() {
  return (
    <Box
      aria-busy="true"
      aria-label="Loading thread timeline"
      className="kodex-timeline-loading kodex-main-column"
      role="status"
    >
      <SkeletonUserBubble lines={["full", "short"]} />
      <Box aria-hidden="true" className="kodex-timeline-skeleton-divider" />
      <SkeletonAssistantBlock lines={["long", "medium", "short", "medium", "tiny"]} />
    </Box>
  );
}

function SkeletonUserBubble({ lines }: { lines: SkeletonLineWidth[] }) {
  return (
    <Box aria-hidden="true" className="kodex-timeline-skeleton-row kodex-timeline-skeleton-user">
      <Box className="kodex-timeline-skeleton-user-bubble">
        {lines.map((line, index) => (
          <Skeleton
            className="kodex-timeline-skeleton-user-line"
            data-line-width={line}
            key={`${line}-${index}`}
            radius="xl"
          />
        ))}
      </Box>
    </Box>
  );
}

function SkeletonAssistantBlock({ lines }: { lines: SkeletonLineWidth[] }) {
  return (
    <Box aria-hidden="true" className="kodex-timeline-skeleton-row kodex-timeline-skeleton-assistant">
      {lines.map((line, index) => (
        <Skeleton
          className="kodex-timeline-skeleton-assistant-line"
          data-line-width={line}
          key={`${line}-${index}`}
          radius="xl"
        />
      ))}
    </Box>
  );
}

type SkeletonLineWidth = "full" | "long" | "medium" | "short" | "tiny";

function ThreadHeader({
  children,
  onShowMobileSidebar,
  title,
}: {
  children?: ReactNode;
  onShowMobileSidebar: () => void;
  title: string | null;
}) {
  return (
    <Group justify="space-between" wrap="nowrap" className="kodex-thread-header">
      <Group gap="xs" wrap="nowrap" className="kodex-thread-heading">
        <ActionIcon
          aria-label={THREAD_PANEL_TEXT.showSidebar}
          className="kodex-thread-sidebar-button"
          onClick={onShowMobileSidebar}
          variant="subtle"
        >
          <PanelLeftOpen size={17} />
        </ActionIcon>
        {title ? (
          <Title className="kodex-thread-title" order={3} size="h5" title={title}>
            {title}
          </Title>
        ) : null}
      </Group>
      {children}
    </Group>
  );
}
