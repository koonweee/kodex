import { Alert, Badge, Box, Button, Group, Loader, Select, Stack, Text } from "@mantine/core";
import { Bot } from "lucide-react";

import type { Approval, ApprovalResponse, ThreadSubagentSummary } from "../api/client";
import { AsyncQuestionAnswersProvider } from "../composer/AsyncQuestionReplyProvider";
import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import { TimelineView } from "../timeline/TimelineView";
import { useReadonlyThreadTimeline } from "../timeline/useReadonlyThreadTimeline";
import { PaneLayout } from "../shared/PaneLayout";
import { errorMessageFrom } from "../shared/values";

const EMPTY_APPROVALS: Approval[] = [];
const noopApprovalDecision = (_approval: Approval, _decision: ApprovalResponse) => {};
const noopReady = () => {};

export function SubagentThreadViewer({
  imagePreviewUrlsByPath,
  onError,
  onImageOpen,
  onMarkdownOpen,
  onSelectSubagent,
  selectedSubagentId,
  showDebugEvents,
  subagents,
  hasMore,
  loadingMore,
  onLoadMore,
  error,
  onReload,
}: {
  imagePreviewUrlsByPath: Record<string, string>;
  onError: (error: unknown) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  onSelectSubagent: (threadId: string) => void;
  selectedSubagentId: string | null;
  showDebugEvents: boolean;
  subagents: ThreadSubagentSummary[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  error: Error | null;
  onReload: () => void;
}) {
  const selectedSubagent =
    subagents.find((subagent) => subagent.id === selectedSubagentId) ?? subagents[0] ?? null;
  const {
    isLoading,
    scrollParentElement,
    setScrollParentElement,
    timeline,
    timelineEntry,
  } = useReadonlyThreadTimeline({
    onError,
    threadId: selectedSubagent?.id ?? null,
  });

  const selectorData = subagents.map((subagent) => ({
    label: subagentLabel(subagent),
    value: subagent.id,
  }));

  return (
    <PaneLayout component="aside" aria-label="Subagent thread viewer" className="kodex-subagent-viewer">
      <Stack className="kodex-subagent-viewer-inner" gap="sm">
        {error ? (
          <Alert color="red" title="Subagents could not be loaded">
            {errorMessageFrom(error)}
            <Button variant="subtle" size="compact-sm" onClick={onReload}>Reload subagents</Button>
          </Alert>
        ) : null}
        {!selectedSubagent ? !error && <Text size="sm" c="dimmed">No subagents in the current native list.</Text> : <>
        <Group className="kodex-subagent-viewer-header" gap="xs" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" className="kodex-subagent-viewer-heading">
            <Bot size={16} />
            <Text fw={700} size="sm" truncate>
              {subagentLabel(selectedSubagent)}
            </Text>
          </Group>
          <Badge data-tone={statusTone(selectedSubagent.status)} size="xs" variant="light">
            {statusLabel(selectedSubagent.status)}
          </Badge>
        </Group>
        {/* Keep the portal out of document overflow while measuring mobile pane fit. */}
        <Select
            label="Subagent"
            className="kodex-subagent-selector"
            comboboxProps={{ floatingStrategy: "fixed" }}
            data={selectorData}
            onChange={(id) => { if (id) onSelectSubagent(id); }}
            allowDeselect={false}
            searchable
            size="xs"
            value={selectedSubagent.id}
        />
        {selectedSubagent.canAcceptDirectInput === false ? (
          <Badge variant="light" size="xs">Read-only</Badge>
        ) : selectedSubagent.canAcceptDirectInput === null ? (
          <Badge variant="light" size="xs">Input capability unknown</Badge>
        ) : null}
        <Box
          className="kodex-subagent-timeline-scroll"
          data-entry-phase={timelineEntry.phase}
          ref={setScrollParentElement}
        >
          {isLoading ? (
            <Group className="kodex-subagent-loading" gap="xs" justify="center">
              <Loader size="sm" />
              <Text c="dimmed" size="sm">
                Loading subagent
              </Text>
            </Group>
          ) : (
            <AsyncQuestionAnswersProvider items={timeline.items}><TimelineView
              approvals={EMPTY_APPROVALS}
              imagePreviewUrlsByPath={imagePreviewUrlsByPath}
              onApprovalDecision={noopApprovalDecision}
              onImageOpen={onImageOpen}
              onMarkdownOpen={onMarkdownOpen}
              onReady={noopReady}
              scrollParentElement={scrollParentElement}
              showDebug={showDebugEvents}
              threadId={selectedSubagent.id}
              timeline={timeline}
            /></AsyncQuestionAnswersProvider>
          )}
        </Box>
        </>}
        {hasMore ? <Button variant="subtle" size="compact-sm" onClick={onLoadMore} loading={loadingMore}>Load more subagents</Button> : null}
      </Stack>
    </PaneLayout>
  );
}

function subagentLabel(subagent: ThreadSubagentSummary): string {
  if (subagent.agentNickname) {
    return subagent.agentRole
      ? `${subagent.agentNickname} [${subagent.agentRole}]`
      : subagent.agentNickname;
  }
  if (subagent.agentRole) {
    return subagent.agentRole;
  }
  return subagent.name || subagent.preview || `Agent ${subagent.id.slice(0, 8)}`;
}

function statusLabel(status: ThreadSubagentSummary["status"]): string {
  switch (status) {
    case "active":
      return "Active";
    case "systemError":
      return "System error";
    case "notLoaded":
      return "Not loaded";
    case "idle":
    default:
      return "Idle";
  }
}

function statusTone(status: ThreadSubagentSummary["status"]): string {
  if (status === "active") {
    return "success";
  }
  if (status === "notLoaded") {
    return "muted";
  }
  return "neutral";
}
