import { ActionIcon, Badge, Box, Button, Group, Menu, Title } from "@mantine/core";
import { AlertCircle, Archive, MoreHorizontal, PanelLeftOpen, PanelRightOpen } from "lucide-react";
import type { ReactNode } from "react";

import type { Approval, ApprovalResponse, ThreadSummary } from "../api/client";
import type { ImageLightboxImage } from "../images/types";
import { EmptyPanel } from "../ui/EmptyPanel";
import { TimelineView } from "../timeline/TimelineView";
import type { TimelineEntry } from "../timeline/entry";
import type { TimelineState } from "../timeline/reducer";

const THREAD_PANEL_TEXT = {
  actions: "Thread actions",
  archive: "Archive thread",
  browseThreads: "Browse threads",
  showSidebar: "Show sidebar",
  threadTimelineText: "Select or create a thread to view events, messages, tool calls, and warnings.",
  threadTimelineTitle: "Thread timeline",
};

export function ThreadPanel({
  errorMessage,
  imagePreviewUrlsByPath,
  isDraftThreadSelected,
  isSelectedTimelineLoading,
  onArchiveThread,
  onApprovalDecision,
  onImageOpen,
  onShowMobileSidebar,
  onTimelineReady,
  pendingTitleThreadIds,
  scrollParentElement,
  selectedThread,
  selectedThreadApprovals,
  selectedThreadTitle,
  selectedTimelineEntry,
  setTimelineScrollElement,
  showDebugEvents,
  timeline,
}: {
  errorMessage: string | null;
  imagePreviewUrlsByPath: Record<string, string>;
  isDraftThreadSelected: boolean;
  isSelectedTimelineLoading: boolean;
  onArchiveThread: () => void;
  onApprovalDecision: (approval: Approval, decision: ApprovalResponse) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onShowMobileSidebar: () => void;
  onTimelineReady: () => void;
  pendingTitleThreadIds: Set<string>;
  scrollParentElement: HTMLDivElement | null;
  selectedThread: ThreadSummary | null;
  selectedThreadApprovals: Approval[];
  selectedThreadTitle: string;
  selectedTimelineEntry: TimelineEntry;
  setTimelineScrollElement: (element: HTMLDivElement | null) => void;
  showDebugEvents: boolean;
  timeline: TimelineState;
}) {
  const selectedThreadTitleIsPending = selectedThread ? pendingTitleThreadIds.has(selectedThread.id) : false;
  const shouldShowThreadTitle = selectedThread !== null && !selectedThreadTitleIsPending;

  return (
    <>
      {errorMessage ? (
        <Badge
          className="kodex-main-column kodex-ui-badge"
          data-tone="danger"
          variant="light"
          leftSection={<AlertCircle size={12} />}
        >
          {errorMessage}
        </Badge>
      ) : null}
      {selectedThread || isDraftThreadSelected ? (
        <>
          <ThreadHeader
            onShowMobileSidebar={onShowMobileSidebar}
            title={shouldShowThreadTitle ? selectedThreadTitle : null}
          >
            {selectedThread ? (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon aria-label={THREAD_PANEL_TEXT.actions} variant="subtle">
                    <MoreHorizontal size={17} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item leftSection={<Archive size={14} />} onClick={onArchiveThread}>
                    {THREAD_PANEL_TEXT.archive}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            ) : null}
          </ThreadHeader>
          {selectedThread ? (
            <Box
              className="kodex-timeline-scroll"
              data-entry-phase={selectedTimelineEntry.phase}
              ref={setTimelineScrollElement}
            >
              {isSelectedTimelineLoading ? (
                <Box aria-busy="true" className="kodex-timeline-loading" />
              ) : (
                <TimelineView
                  key={selectedThread.id}
                  approvals={selectedThreadApprovals}
                  onReady={onTimelineReady}
                  onApprovalDecision={onApprovalDecision}
                  onImageOpen={onImageOpen}
                  imagePreviewUrlsByPath={imagePreviewUrlsByPath}
                  scrollParentElement={scrollParentElement}
                  showDebug={showDebugEvents}
                  threadId={selectedThread.id}
                  timeline={timeline}
                />
              )}
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
