import { Badge, Box, Group, Text } from "@mantine/core";
import { memo } from "react";
import type { ReactNode } from "react";

import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import {
  CollabAgentBlock,
  CommandBlock,
  PlanBlock,
  ReasoningBlock,
  StatusMarker,
  TimelineActivityGroupRenderer,
  TimelineWorkRowRenderer,
  ToolCallBlock,
  WebSearchBlock,
} from "./activityRenderers";
import { FileChangeBlock, TimelineFileChangesRenderer } from "./fileRenderers";
import { ImageActivityBlock } from "./imageRenderers";
import { AssistantMessageMarkdown, UserMessageBubble } from "./messageRenderers";
import {
  DebugDisclosure,
  isTimelineMessage,
  statusLabel,
  statusTone,
  TimelineIcon,
  timelineItemLabels,
  unknownRenderer,
} from "./rendererShared";
import type { TimelineItem } from "./reducer";

export {
  TimelineActivityGroupRenderer,
  TimelineFileChangesRenderer,
  TimelineWorkRowRenderer,
};

type TimelineRendererOptions = {
  imagePreviewUrlsByPath: Record<string, string>;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  threadId?: string;
  toolbarTimestampMs?: number;
};
type TimelineRenderer = (item: TimelineItem, options: TimelineRendererOptions) => ReactNode;

const rendererRegistry: Record<string, TimelineRenderer> = {
  agent_message: (item, options) => (
    <AssistantMessageMarkdown
      item={item}
      onImageOpen={options.onImageOpen}
      onMarkdownOpen={options.onMarkdownOpen}
      text={item.text || "No assistant content yet"}
      threadId={options.threadId}
      toolbarTimestampMs={options.toolbarTimestampMs}
    />
  ),
  assistant_message: (item, options) => (
    <AssistantMessageMarkdown
      item={item}
      onImageOpen={options.onImageOpen}
      onMarkdownOpen={options.onMarkdownOpen}
      text={item.text || "No assistant content yet"}
      threadId={options.threadId}
      toolbarTimestampMs={options.toolbarTimestampMs}
    />
  ),
  user_message: (item, options) => (
    <UserMessageBubble
      item={item}
      imagePreviewUrlsByPath={options.imagePreviewUrlsByPath}
      onImageOpen={options.onImageOpen}
      threadId={options.threadId}
      toolbarTimestampMs={options.toolbarTimestampMs}
    />
  ),
  reasoning_summary: (item) => <ReasoningBlock item={item} />,
  reasoning: (item) => <ReasoningBlock item={item} />,
  command_execution: (item) => <CommandBlock item={item} />,
  file_change: (item) => <FileChangeBlock item={item} />,
  mcp_tool_call: (item) => <ToolCallBlock item={item} />,
  dynamic_tool_call: (item) => <ToolCallBlock item={item} />,
  collab_agent_tool_call: (item, options) => (
    <CollabAgentBlock item={item} onMarkdownOpen={options.onMarkdownOpen} threadId={options.threadId} />
  ),
  web_search_group: (item) => <WebSearchBlock actions={item.actions ?? []} />,
  plan: (item) => <PlanBlock item={item} />,
  image_view: (item, options) => (
    <ImageActivityBlock item={item} onImageOpen={options.onImageOpen} threadId={options.threadId} />
  ),
  image_generation: (item, options) => (
    <ImageActivityBlock item={item} onImageOpen={options.onImageOpen} threadId={options.threadId} />
  ),
  review_mode_started: (item) => <StatusMarker item={item} />,
  review_mode_finished: (item) => <StatusMarker item={item} />,
  context_compaction: (item) => <StatusMarker item={item} />,
  warning: (item) => (
    <Text size="sm" className="kodex-ui-text" data-tone="warning">
      {item.text || "Warning"}
    </Text>
  ),
  error: (item) => (
    <Text size="sm" className="kodex-ui-text" data-tone="danger">
      {item.text || "Error"}
    </Text>
  ),
  debug_event: (item) => <Text size="sm">{item.text || "Unsupported item"}</Text>,
};

type TimelineItemRendererProps = {
  item: TimelineItem;
  imagePreviewUrlsByPath?: Record<string, string>;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  showDebug?: boolean;
  threadId?: string;
  toolbarTimestampMs?: number;
};

function TimelineItemRendererImpl({
  item,
  imagePreviewUrlsByPath = {},
  onImageOpen,
  onMarkdownOpen,
  showDebug = false,
  threadId,
  toolbarTimestampMs,
}: TimelineItemRendererProps) {
  const render = rendererRegistry[item.kind] ?? unknownRenderer;
  const label = timelineItemLabels[item.kind] ?? "Unsupported item";
  const isMessage = isTimelineMessage(item.kind);
  const isHeaderlessMarker = item.kind === "context_compaction";
  const showStatus = !isMessage && !isHeaderlessMarker && item.status !== "completed";
  return (
    <Box className={`kodex-timeline-item kodex-timeline-item-${item.kind}`}>
      {(!isMessage && !isHeaderlessMarker) || showStatus ? (
        <Group gap="xs" wrap="nowrap" className="kodex-timeline-item-header" data-message-status={isMessage ? "true" : undefined}>
          {!isMessage && !isHeaderlessMarker ? (
            <>
              <TimelineIcon kind={item.kind} />
              <Text size="xs" fw={700} className="kodex-timeline-label">
                {label}
              </Text>
            </>
          ) : null}
          {showStatus ? (
            <Badge data-tone={statusTone(item.status)} size="xs" variant="light">
              {statusLabel(item.status)}
            </Badge>
          ) : null}
        </Group>
      ) : null}
      {render(item, { imagePreviewUrlsByPath, onImageOpen, onMarkdownOpen, threadId, toolbarTimestampMs })}
      {showDebug ? <DebugDisclosure item={item} /> : null}
    </Box>
  );
}

export const TimelineItemRenderer = memo(TimelineItemRendererImpl);
TimelineItemRenderer.displayName = "TimelineItemRenderer";
