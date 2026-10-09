import { AnimatedNumericText } from "../ui/AnimatedNumericText";
import { Badge, Box, Code, Group, Stack, Text } from "@mantine/core";

import type { MarkdownPreviewRequest } from "../files/types";
import { useThreadDeliveryPreferences } from "./ThreadDeliveryPreferences";
import {
  commandStatusMeta,
  displayCommand,
  LazyMarkdownContent,
  MessageText,
  payloadValue,
  titleCase,
} from "./rendererShared";
import type { TimelineItem, WebSearchAction } from "./reducer";

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
      <summary><AnimatedNumericText text={actions.length === 1 ? "1 action" : `${actions.length} actions`} /></summary>
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

export function collabActivitySummary(item: TimelineItem): string {
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
