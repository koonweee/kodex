import { Badge, Box, Button, Code, Group, Stack, Text } from "@mantine/core";
import { Terminal } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import type { SyntheticEvent } from "react";

import type { MarkdownPreviewRequest } from "../files/types";
import type { ImageLightboxImage } from "../images/types";
import { useThreadDeliveryPreferences } from "./ThreadDeliveryPreferences";
import { ActivityGroupSummary } from "./ActivityGroupSummary";
import { FileChangeBlock } from "./fileRenderers";
import { ImageActivityBlock } from "./imageRenderers";
import { AssistantMessageMarkdown, UserMessageBubble } from "./messageRenderers";
import { fileChangeActionIsModified } from "./presentationFile";
import {
  commandStatusMeta,
  DebugDisclosure,
  displayCommand,
  LazyMarkdownContent,
  MessageText,
  payloadValue,
  TimelineIcon,
  timelineItemLabels,
  titleCase,
  unknownRenderer,
} from "./rendererShared";
import type { TimelineItem, WebSearchAction } from "./reducer";

type TimelineActivityGroupRendererProps = {
  imagePreviewUrlsByPath?: Record<string, string>;
  items: TimelineItem[];
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  showDebug?: boolean;
  threadId?: string;
};

const ACTIVITY_ITEM_RENDER_CHUNK = 80;

function TimelineActivityGroupRendererImpl({
  imagePreviewUrlsByPath = {},
  items,
  onImageOpen,
  onMarkdownOpen,
  showDebug = false,
  threadId,
}: TimelineActivityGroupRendererProps) {
  const itemIdentity = useMemo(() => items.map((item) => item.id).join("\u0000"), [items]);
  const [visibleItemCount, setVisibleItemCount] = useState(ACTIVITY_ITEM_RENDER_CHUNK);
  useEffect(() => {
    setVisibleItemCount(ACTIVITY_ITEM_RENDER_CHUNK);
  }, [itemIdentity]);
  const visibleItems = items.slice(0, visibleItemCount);
  const remainingItemCount = Math.max(0, items.length - visibleItems.length);

  return (
    <details className="kodex-activity-group">
      <summary className="kodex-timeline-intermediate">
        <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
          <Terminal size={15} />
          <ActivityGroupSummary items={items} />
        </Group>
      </summary>
      <Stack gap={4}>
        {visibleItems.map((item) => (
          <ActivityItemRenderer
            imagePreviewUrlsByPath={imagePreviewUrlsByPath}
            item={item}
            key={item.id}
            onImageOpen={onImageOpen}
            onMarkdownOpen={onMarkdownOpen}
            showDebug={showDebug}
            threadId={threadId}
          />
        ))}
        {remainingItemCount > 0 ? (
          <Button
            size="xs"
            variant="subtle"
            onClick={() => setVisibleItemCount((count) => Math.min(items.length, count + ACTIVITY_ITEM_RENDER_CHUNK))}
          >
            Show {Math.min(ACTIVITY_ITEM_RENDER_CHUNK, remainingItemCount)} more
          </Button>
        ) : null}
      </Stack>
    </details>
  );
}

export const TimelineActivityGroupRenderer = memo(TimelineActivityGroupRendererImpl);
TimelineActivityGroupRenderer.displayName = "TimelineActivityGroupRenderer";

export function ReasoningBlock({ item }: { item: TimelineItem }) {
  const summary = item.summary || item.text;
  return (
    <details className="kodex-timeline-disclosure">
      <summary>Summary</summary>
      <Text size="sm">{summary}</Text>
    </details>
  );
}

export function WebSearchBlock({ actions }: { actions: WebSearchAction[] }) {
  return (
    <details className="kodex-timeline-disclosure">
      <summary>{actions.length === 1 ? "1 action" : `${actions.length} actions`}</summary>
      <Stack gap={6} mt={6}>
        {actions.map((action, index) => (
          <Text size="sm" key={`${action.kind}-${index}`} className="kodex-timeline-inline-row">
            {webSearchActionText(action)}
          </Text>
        ))}
      </Stack>
    </details>
  );
}

export function CommandBlock({ item }: { item: TimelineItem }) {
  const { includeCommandOutputs } = useThreadDeliveryPreferences();
  const command = item.command || payloadValue(item.payload, "command");
  const output = item.output || payloadValue(item.payload, "output") || payloadValue(item.payload, "stdout") || payloadValue(item.payload, "stderr");
  const status = commandStatusMeta(item.status);
  return (
    <Stack gap={6} className="kodex-command-panel">
      <Text size="xs" className="kodex-command-shell">
        Shell
      </Text>
      {command ? (
        <Code block className="kodex-timeline-code">
          $ {displayCommand(command)}
        </Code>
      ) : (
        <MessageText text={item.text || "Command"} />
      )}
      {includeCommandOutputs && output ? (
        <Code block className="kodex-timeline-output">
          {output}
        </Code>
      ) : null}
      {status ? (
        <Text size="xs" c="dimmed" className="kodex-activity-status" data-tone={status.tone}>
          <status.Icon size={13} /> {status.label}
        </Text>
      ) : null}
    </Stack>
  );
}

export function ToolCallBlock({ item }: { item: TimelineItem }) {
  return (
    <Stack gap={4}>
      <Text size="sm">{item.toolName || item.text || "Tool call"}</Text>
      {item.argsSummary ? (
        <Text size="xs" c="dimmed" className="kodex-timeline-inline-row">
          Arguments: {item.argsSummary}
        </Text>
      ) : null}
      {item.resultSummary ? (
        <Text size="xs" c="dimmed" className="kodex-timeline-inline-row">
          Result: {item.resultSummary}
        </Text>
      ) : null}
    </Stack>
  );
}

export function CollabAgentBlock({
  item,
  onMarkdownOpen,
  threadId,
}: {
  item: TimelineItem;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  threadId?: string;
}) {
  const collab = item.collab;
  if (collab) {
    return (
      <Stack gap={6} className="kodex-collab-agent-block">
        <Text size="sm" className="kodex-collab-agent-title">
          {item.text || "Agent activity"}
        </Text>
        <CollabAgentChips item={item} />
        {collab.prompt ? (
          <Text size="xs" c="dimmed" className="kodex-collab-agent-preview">
            {collab.prompt}
          </Text>
        ) : null}
        {shouldRenderCollabAgentRows(item) ? (
          <Stack gap={6} className="kodex-collab-agent-list">
            {collab.agents.map((agent) => (
              <Box key={agent.threadId} className="kodex-collab-agent-row">
                <Group gap={6} wrap="nowrap" className="kodex-collab-agent-row-heading">
                  <Text size="xs" fw={700} className="kodex-collab-agent-name">
                    {agent.displayName}
                  </Text>
                  {agent.status ? (
                    <Badge
                      className="kodex-collab-agent-status"
                      data-tone={collabStatusTone(agent.rawStatus)}
                      size="xs"
                      variant="light"
                    >
                      {agent.status}
                    </Badge>
                  ) : null}
                </Group>
                {agent.message ? (
                  <CollabAgentMarkdownPreview text={agent.message} threadId={threadId} onMarkdownOpen={onMarkdownOpen} />
                ) : null}
              </Box>
            ))}
          </Stack>
        ) : null}
      </Stack>
    );
  }
  return (
    <Stack gap={4}>
      <Text size="sm">{item.text || "Agent activity"}</Text>
      {item.argsSummary ? (
        <Text size="xs" c="dimmed" className="kodex-timeline-inline-row">
          Details: {item.argsSummary}
        </Text>
      ) : null}
      {item.resultSummary ? (
        <Text size="xs" c="dimmed" className="kodex-timeline-inline-row">
          Result: {item.resultSummary}
        </Text>
      ) : null}
    </Stack>
  );
}

export function PlanBlock({ item }: { item: TimelineItem }) {
  return <Text size="sm">{item.text || "Plan updated"}</Text>;
}

export function StatusMarker({ item }: { item: TimelineItem }) {
  return (
    <Text
      size="sm"
      c="dimmed"
      className={`kodex-timeline-inline-row${item.kind === "context_compaction" ? " kodex-timeline-intermediate" : ""}`}
    >
      {item.text}
    </Text>
  );
}

const ActivityItemRenderer = memo(function ActivityItemRenderer({
  imagePreviewUrlsByPath,
  item,
  onImageOpen,
  onMarkdownOpen,
  showDebug,
  threadId,
}: {
  imagePreviewUrlsByPath: Record<string, string>;
  item: TimelineItem;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  showDebug: boolean;
  threadId?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setIsOpen(event.currentTarget.open);
  };

  if (item.kind === "command_execution") {
    const status = commandStatusMeta(item.status);
    return (
      <details className="kodex-activity-item" onToggle={handleToggle}>
        <summary className="kodex-timeline-intermediate">
          <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
            <Terminal size={15} />
            <Text size="xs" c="dimmed" className="kodex-activity-title" title={commandSummary(item)}>
              {commandSummary(item)}
            </Text>
            {status ? (
              <Badge data-tone={status.tone} size="xs" variant="light">
                {status.label}
              </Badge>
            ) : null}
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
    <details className="kodex-activity-item" onToggle={handleToggle}>
      <summary className="kodex-timeline-intermediate">
        <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
          <TimelineIcon kind={item.kind} />
          <Text size="xs" c="dimmed" className="kodex-activity-title" title={activityItemSummary(item)}>
            {activityItemSummary(item)}
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
    return (
      <AssistantMessageMarkdown
        item={item}
        onImageOpen={options.onImageOpen}
        onMarkdownOpen={options.onMarkdownOpen}
        text={item.text || "No assistant content yet"}
        threadId={options.threadId}
      />
    );
  }
  if (item.kind === "user_message") {
    return (
      <UserMessageBubble
        item={item}
        imagePreviewUrlsByPath={options.imagePreviewUrlsByPath}
        onImageOpen={options.onImageOpen}
        onMarkdownOpen={options.onMarkdownOpen}
        threadId={options.threadId}
      />
    );
  }
  if (item.kind === "reasoning_summary" || item.kind === "reasoning") {
    return <ReasoningBlock item={item} />;
  }
  if (item.kind === "command_execution") {
    return <CommandBlock item={item} />;
  }
  if (item.kind === "file_change") {
    return <FileChangeBlock item={item} />;
  }
  if (item.kind === "mcp_tool_call" || item.kind === "dynamic_tool_call") {
    return <ToolCallBlock item={item} />;
  }
  if (item.kind === "collab_agent_tool_call") {
    return <CollabAgentBlock item={item} onMarkdownOpen={options.onMarkdownOpen} threadId={options.threadId} />;
  }
  if (item.kind === "web_search_group") {
    return <WebSearchBlock actions={item.actions ?? []} />;
  }
  if (item.kind === "plan") {
    return <PlanBlock item={item} />;
  }
  if (item.kind === "image_view" || item.kind === "image_generation") {
    return <ImageActivityBlock item={item} onImageOpen={options.onImageOpen} threadId={options.threadId} />;
  }
  if (item.kind === "review_mode_started" || item.kind === "review_mode_finished" || item.kind === "context_compaction") {
    return <StatusMarker item={item} />;
  }
  if (item.kind === "warning") {
    return (
      <Text size="sm" className="kodex-ui-text" data-tone="warning">
        {item.text || "Warning"}
      </Text>
    );
  }
  if (item.kind === "error") {
    return (
      <Text size="sm" className="kodex-ui-text" data-tone="danger">
        {item.text || "Error"}
      </Text>
    );
  }
  if (item.kind === "debug_event") {
    return <Text size="sm">{item.text || "Unsupported item"}</Text>;
  }
  return unknownRenderer(item);
}

function webSearchActionText(action: WebSearchAction): string {
  if (action.kind === "search") {
    return `Searched web for "${action.query}"`;
  }
  if (action.kind === "open") {
    const target = action.title || action.url;
    return target ? `Opened page ${target}` : "Opened page";
  }
  return action.label;
}

function commandSummary(item: TimelineItem): string {
  const command = displayCommand(item.command || payloadValue(item.payload, "command"));
  if (!command) {
    return "Ran command";
  }
  if (command === "rg --files" || command === "find . -maxdepth 1 -type f" || command === "ls") {
    return "Listed files";
  }
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
  if (item.kind === "mcp_tool_call" || item.kind === "dynamic_tool_call") {
    return item.toolName ? `Used ${item.toolName}` : "Used tool";
  }
  if (item.kind === "collab_agent_tool_call") {
    return collabActivitySummary(item);
  }
  if (item.kind === "image_view" || item.kind === "image_generation") {
    return item.text || "Image activity";
  }
  return timelineItemLabels[item.kind] ?? "Activity";
}

function collabActivitySummary(item: TimelineItem): string {
  if (item.toolName === "wait" && item.status === "running" && item.collab && item.collab.agents.length > 1) {
    return `Waiting for ${item.collab.agents.length} agents`;
  }
  if (item.text) {
    return item.text;
  }
  return "Agent activity";
}

function CollabAgentChips({ item }: { item: TimelineItem }) {
  const collab = item.collab;
  const chips = [
    collab?.model,
    collab?.reasoningEffort ? titleCase(collab.reasoningEffort) : "",
    item.status === "running" ? "Running" : item.status === "failed" ? "Failed" : "",
  ].filter(Boolean);
  if (chips.length === 0) {
    return null;
  }
  return (
    <Group gap={4} wrap="wrap" className="kodex-collab-agent-chips">
      {chips.map((chip) => (
        <Badge key={chip} data-tone={chip === "Failed" ? "danger" : "neutral"} size="xs" variant="light">
          {chip}
        </Badge>
      ))}
    </Group>
  );
}

function shouldRenderCollabAgentRows(item: TimelineItem): boolean {
  const agents = item.collab?.agents ?? [];
  return agents.some((agent) => agent.status || agent.message) || (item.toolName === "wait" && agents.length > 0);
}

function CollabAgentMarkdownPreview({
  onMarkdownOpen,
  text,
  threadId,
}: {
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  text: string;
  threadId?: string;
}) {
  return (
    <LazyMarkdownContent
      className="kodex-collab-agent-markdown kodex-assistant-markdown"
      fallbackText={text}
      onMarkdownOpen={onMarkdownOpen}
      text={text}
      threadId={threadId}
    />
  );
}

function collabStatusTone(status?: string): "danger" | "neutral" | "success" | "warning" {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "completed") {
    return "success";
  }
  if (normalized === "errored" || normalized === "notfound") {
    return "danger";
  }
  if (normalized === "interrupted" || normalized === "shutdown") {
    return "warning";
  }
  return "neutral";
}
