import { ActionIcon, Badge, Box, Group, Menu, Stack, Title } from "@mantine/core";
import { AlertCircle, Archive, Inbox, MoreHorizontal, PanelRightOpen } from "lucide-react";

import type { Approval, ApprovalResponse, ThreadSummary } from "../api/client";
import { EmptyPanel } from "../ui/EmptyPanel";
import { TimelineView } from "../timeline/TimelineView";
import type { TimelineEntry } from "../timeline/entry";
import type { TimelineState } from "../timeline/reducer";

const THREAD_PANEL_TEXT = {
  actions: "Thread actions",
  archive: "Archive thread",
  noEventsText: "Thread activity will stream into this timeline.",
  noEventsTitle: "No events",
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
  return (
    <>
      {errorMessage ? (
        <Badge className="kodex-main-column" color="red" variant="light" leftSection={<AlertCircle size={12} />}>
          {errorMessage}
        </Badge>
      ) : null}
      {selectedThread || isDraftThreadSelected ? (
        <>
          <Group justify="space-between" wrap="nowrap" className="kodex-thread-header">
            <Box className="kodex-thread-heading">
              <Title
                className="kodex-thread-title"
                c={selectedThread && pendingTitleThreadIds.has(selectedThread.id) ? "dimmed" : undefined}
                data-placeholder-title={selectedThread && pendingTitleThreadIds.has(selectedThread.id) ? "true" : undefined}
                order={3}
                size="h5"
                title={selectedThreadTitle}
              >
                {selectedThreadTitle}
              </Title>
            </Box>
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
          </Group>
          <Box
            className="kodex-timeline-scroll"
            data-entry-phase={selectedTimelineEntry.phase}
            ref={setTimelineScrollElement}
          >
            {selectedThread && isSelectedTimelineLoading ? (
              <Box aria-busy="true" className="kodex-timeline-loading" />
            ) : selectedThread ? (
              <TimelineView
                key={selectedThread.id}
                approvals={selectedThreadApprovals}
                onReady={onTimelineReady}
                onApprovalDecision={onApprovalDecision}
                imagePreviewUrlsByPath={imagePreviewUrlsByPath}
                scrollParentElement={scrollParentElement}
                showDebug={showDebugEvents}
                timeline={timeline}
              />
            ) : (
              <EmptyPanel
                icon={<Inbox size={20} />}
                title={THREAD_PANEL_TEXT.noEventsTitle}
                text={THREAD_PANEL_TEXT.noEventsText}
              />
            )}
          </Box>
        </>
      ) : (
        <Box className="kodex-thread-empty kodex-main-column">
          <EmptyPanel
            icon={<PanelRightOpen size={22} />}
            title={THREAD_PANEL_TEXT.threadTimelineTitle}
            text={THREAD_PANEL_TEXT.threadTimelineText}
          />
        </Box>
      )}
    </>
  );
}
