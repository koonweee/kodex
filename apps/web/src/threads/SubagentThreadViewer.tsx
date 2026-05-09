import { Badge, Box, Group, Loader, SegmentedControl, Stack, Text } from "@mantine/core";
import { Bot } from "lucide-react";

import type { Approval, ApprovalResponse, ThreadSubagentSummary } from "../api/client";
import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import { TimelineView } from "../timeline/TimelineView";
import { useReadonlyThreadTimeline } from "../timeline/useReadonlyThreadTimeline";

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
}: {
  imagePreviewUrlsByPath: Record<string, string>;
  onError: (error: unknown) => void;
  onImageOpen: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  onSelectSubagent: (threadId: string) => void;
  selectedSubagentId: string | null;
  showDebugEvents: boolean;
  subagents: ThreadSubagentSummary[];
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

  if (!selectedSubagent) {
    return null;
  }

  const selectorData = subagents.map((subagent) => ({
    label: subagentLabel(subagent),
    value: subagent.id,
  }));

  return (
    <aside aria-label="Subagent thread viewer" className="kodex-subagent-viewer">
      <Stack className="kodex-subagent-viewer-inner" gap="sm">
        <Group className="kodex-subagent-viewer-header" gap="xs" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" className="kodex-subagent-viewer-heading">
            <Bot size={16} />
            <Text fw={700} size="sm" truncate>
              {subagentLabel(selectedSubagent)}
            </Text>
          </Group>
          <Badge data-tone={statusTone(selectedSubagent.liveState)} size="xs" variant="light">
            {statusLabel(selectedSubagent.liveState)}
          </Badge>
        </Group>
        {selectorData.length > 1 ? (
          <SegmentedControl
            aria-label="Select subagent"
            className="kodex-subagent-selector"
            data={selectorData}
            onChange={onSelectSubagent}
            size="xs"
            value={selectedSubagent.id}
          />
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
            <TimelineView
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
            />
          )}
        </Box>
      </Stack>
    </aside>
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
  return `Agent ${subagent.id.slice(0, 8)}`;
}

function statusLabel(liveState: ThreadSubagentSummary["liveState"]): string {
  switch (liveState) {
    case "streaming":
      return "Active";
    case "syncing":
      return "Syncing";
    case "notLoaded":
      return "Unavailable";
    case "idle":
    default:
      return "Idle";
  }
}

function statusTone(liveState: ThreadSubagentSummary["liveState"]): string {
  if (liveState === "streaming") {
    return "success";
  }
  if (liveState === "notLoaded") {
    return "muted";
  }
  return "neutral";
}
