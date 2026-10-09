import { AnimatedNumericText } from "../ui/AnimatedNumericText";
import { Badge, Box, Button, Group, Stack, Text } from "@mantine/core";
import { Terminal } from "lucide-react";
import { memo, useState } from "react";
import type { SyntheticEvent } from "react";

import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import {
  CollabAgentBlock,
  collabActivitySummary,
  CommandBlock,
  PlanBlock,
  ReasoningBlock,
  StatusMarker,
  ToolCallBlock,
  WebSearchBlock,
} from "./activityRenderers";
import { ActivityGroupSummary } from "./ActivityGroupSummary";
import { FileChangeBlock } from "./fileRenderers";
import { ImageActivityBlock } from "./imageRenderers";
import { AssistantMessageMarkdown, UserMessageBubble } from "./messageRenderers";
import { fileChangeActionIsModified } from "./presentationFile";
import {
  commandStatusMeta,
  DebugDisclosure,
  displayCommand,
  payloadValue,
  TimelineIcon,
  timelineItemLabels,
  unknownRenderer,
} from "./rendererShared";
import type { TimelineItem } from "./reducer";

type TimelineActivityGroupRendererProps = {
  expanded?: boolean;
  expandedItemIds?: ReadonlySet<string>;
  hasOpened?: boolean;
  imagePreviewUrlsByPath?: Record<string, string>;
  items: TimelineItem[];
  onExpandedChange?: (expanded: boolean) => void;
  onItemExpandedChange?: (itemId: string, expanded: boolean) => void;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  onVisibleItemCountChange?: (visibleItemCount: number) => void;
  showDebug?: boolean;
  threadId?: string;
  visibleItemCount?: number;
};

export const ACTIVITY_ITEM_RENDER_CHUNK = 80;

function TimelineActivityGroupRendererImpl({
  expanded,
  expandedItemIds,
  hasOpened,
  imagePreviewUrlsByPath = {},
  items,
  onExpandedChange,
  onItemExpandedChange,
  onImageOpen,
  onMarkdownOpen,
  onVisibleItemCountChange,
  showDebug = false,
  threadId,
  visibleItemCount,
}: TimelineActivityGroupRendererProps) {
  const [localHasOpened, setLocalHasOpened] = useState(false);
  const [localVisibleItemCount, setLocalVisibleItemCount] = useState(ACTIVITY_ITEM_RENDER_CHUNK);
  const isControlled = expanded !== undefined;
  const shouldRenderItems = isControlled ? Boolean(expanded || hasOpened) : localHasOpened;
  const renderedItemCount = visibleItemCount ?? localVisibleItemCount;
  const visibleItems = items.slice(0, renderedItemCount);
  const remainingItemCount = Math.max(0, items.length - visibleItems.length);
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!isControlled) {
      if (event.currentTarget.open) setLocalHasOpened(true);
      onExpandedChange?.(event.currentTarget.open);
    } else if (event.currentTarget.open !== expanded) {
      onExpandedChange?.(event.currentTarget.open);
    }
  };
  const revealMoreItems = () => {
    const nextCount = Math.min(items.length, renderedItemCount + ACTIVITY_ITEM_RENDER_CHUNK);
    if (visibleItemCount === undefined) setLocalVisibleItemCount(nextCount);
    onVisibleItemCountChange?.(nextCount);
  };

  return (
    <details className="kodex-activity-group" onToggle={handleToggle} open={expanded}>
      <summary className="kodex-timeline-intermediate">
        <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
          <Terminal size={15} />
          <ActivityGroupSummary items={items} />
        </Group>
      </summary>
      {shouldRenderItems ? (
        <Stack className="kodex-activity-contents" gap={4}>
          {visibleItems.map((item) => (
            <ActivityItemRenderer
              expanded={expandedItemIds?.has(item.id)}
              imagePreviewUrlsByPath={imagePreviewUrlsByPath}
              item={item}
              key={item.id}
              onExpandedChange={(itemExpanded) => onItemExpandedChange?.(item.id, itemExpanded)}
              onImageOpen={onImageOpen}
              onMarkdownOpen={onMarkdownOpen}
              showDebug={showDebug}
              threadId={threadId}
            />
          ))}
          {remainingItemCount > 0 ? (
            <Button size="xs" variant="subtle" onClick={revealMoreItems}>
              <AnimatedNumericText text={`Show ${Math.min(ACTIVITY_ITEM_RENDER_CHUNK, remainingItemCount)} more`} />
            </Button>
          ) : null}
        </Stack>
      ) : null}
    </details>
  );
}

export const TimelineActivityGroupRenderer = memo(TimelineActivityGroupRendererImpl);
TimelineActivityGroupRenderer.displayName = "TimelineActivityGroupRenderer";

const ActivityItemRenderer = memo(function ActivityItemRenderer({
  expanded,
  imagePreviewUrlsByPath,
  item,
  onExpandedChange,
  onImageOpen,
  onMarkdownOpen,
  showDebug,
  threadId,
}: {
  expanded?: boolean;
  imagePreviewUrlsByPath: Record<string, string>;
  item: TimelineItem;
  onExpandedChange?: (expanded: boolean) => void;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  showDebug: boolean;
  threadId?: string;
}) {
  const [localIsOpen, setLocalIsOpen] = useState(false);
  const isOpen = expanded ?? localIsOpen;
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (expanded === undefined) {
      setLocalIsOpen(event.currentTarget.open);
      onExpandedChange?.(event.currentTarget.open);
    } else if (event.currentTarget.open !== expanded) {
      onExpandedChange?.(event.currentTarget.open);
    }
  };

  if (item.kind === "command_execution") {
    const status = commandStatusMeta(item.status);
    return (
      <details className="kodex-activity-item" onToggle={handleToggle} open={expanded}>
        <summary className="kodex-timeline-intermediate">
          <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
            <Terminal size={15} />
            <Text size="xs" c="dimmed" className="kodex-activity-title" title={commandSummary(item)}>
              {commandSummary(item)}
            </Text>
            {status ? <Badge data-tone={status.tone} size="xs" variant="light">{status.label}</Badge> : null}
          </Group>
        </summary>
        {isOpen ? (
          <>
            <CommandBlock item={item} />
            {showDebug ? <DebugDisclosure item={item} /> : null}
          </>
        ) : null}
      </details>
    );
  }

  return (
    <details className="kodex-activity-item" onToggle={handleToggle} open={expanded}>
      <summary className="kodex-timeline-intermediate">
        <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
          <TimelineIcon kind={item.kind} />
          <Text size="xs" c="dimmed" className="kodex-activity-title" title={activityItemSummary(item)}>
            {item.kind === "web_search_group" || (item.kind === "collab_agent_tool_call" && item.toolName === "wait" && item.status === "running")
              ? <AnimatedNumericText text={activityItemSummary(item)} /> : activityItemSummary(item)}
          </Text>
        </Group>
      </summary>
      {isOpen ? (
        <>
          <Box className="kodex-activity-body">
            {renderActivityItemBody(item, { imagePreviewUrlsByPath, onImageOpen, onMarkdownOpen, threadId })}
          </Box>
          {showDebug ? <DebugDisclosure item={item} /> : null}
        </>
      ) : null}
    </details>
  );
});
ActivityItemRenderer.displayName = "ActivityItemRenderer";

function renderActivityItemBody(
  item: TimelineItem,
  options: {
    imagePreviewUrlsByPath: Record<string, string>;
    onImageOpen?: (image: ImageLightboxImage) => void;
    onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
    threadId?: string;
  },
) {
  if (item.kind === "agent_message" || item.kind === "assistant_message") {
    return <AssistantMessageMarkdown item={item} onImageOpen={options.onImageOpen} onMarkdownOpen={options.onMarkdownOpen} text={item.text || "No assistant content yet"} threadId={options.threadId} />;
  }
  if (item.kind === "user_message") {
    return <UserMessageBubble item={item} imagePreviewUrlsByPath={options.imagePreviewUrlsByPath} onImageOpen={options.onImageOpen} onMarkdownOpen={options.onMarkdownOpen} threadId={options.threadId} />;
  }
  if (item.kind === "reasoning_summary" || item.kind === "reasoning") return <ReasoningBlock item={item} />;
  if (item.kind === "command_execution") return <CommandBlock item={item} />;
  if (item.kind === "file_change") return <FileChangeBlock item={item} />;
  if (item.kind === "mcp_tool_call" || item.kind === "dynamic_tool_call") return <ToolCallBlock item={item} />;
  if (item.kind === "collab_agent_tool_call") return <CollabAgentBlock item={item} onMarkdownOpen={options.onMarkdownOpen} threadId={options.threadId} />;
  if (item.kind === "web_search_group") return <WebSearchBlock actions={item.actions ?? []} />;
  if (item.kind === "plan") return <PlanBlock item={item} />;
  if (item.kind === "image_view" || item.kind === "image_generation") return <ImageActivityBlock item={item} onImageOpen={options.onImageOpen} threadId={options.threadId} />;
  if (item.kind === "review_mode_started" || item.kind === "review_mode_finished" || item.kind === "context_compaction") return <StatusMarker item={item} />;
  if (item.kind === "warning") return <Text size="sm" className="kodex-ui-text" data-tone="warning">{item.text || "Warning"}</Text>;
  if (item.kind === "error") return <Text size="sm" className="kodex-ui-text" data-tone="danger">{item.text || "Error"}</Text>;
  if (item.kind === "debug_event") return <Text size="sm">{item.text || "Unsupported item"}</Text>;
  return unknownRenderer(item);
}

function commandSummary(item: TimelineItem): string {
  const command = displayCommand(item.command || payloadValue(item.payload, "command"));
  if (!command) return "Ran command";
  if (command === "rg --files" || command === "find . -maxdepth 1 -type f" || command === "ls") return "Listed files";
  return `Ran ${command}`;
}

function activityItemSummary(item: TimelineItem): string {
  if (item.kind === "file_change") {
    const path = item.path || payloadValue(item.payload, "path");
    const action = fileChangeActionIsModified(item.action) ? "Modified" : item.action || "Modified";
    return path ? `${action} ${path}` : `${action} files`;
  }
  if (item.kind === "web_search_group") {
    const count = item.actions?.length ?? 0;
    return count === 1 ? "Searched web" : `Searched web, ${count} actions`;
  }
  if (item.kind === "mcp_tool_call" || item.kind === "dynamic_tool_call") return item.toolName ? `Used ${item.toolName}` : "Used tool";
  if (item.kind === "collab_agent_tool_call") {
    return collabActivitySummary(item);
  }
  if (item.kind === "image_view" || item.kind === "image_generation") return item.text || "Image activity";
  return timelineItemLabels[item.kind] ?? "Activity";
}
