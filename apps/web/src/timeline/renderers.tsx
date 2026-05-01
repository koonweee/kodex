import { Badge, Box, Group, Text } from "@mantine/core";
import { AlertTriangle, Bot, Code2, FileDiff, ListChecks, Terminal, Wrench } from "lucide-react";

import type { TimelineItem } from "./reducer";

type TimelineRenderer = (item: TimelineItem) => React.ReactNode;

const rendererRegistry: Record<string, TimelineRenderer> = {
  agent_message: (item) => <Text size="sm">{item.text || "No assistant content yet"}</Text>,
  user_message: (item) => <Text size="sm">{item.text || "No user content"}</Text>,
  reasoning: (item) => <Text size="sm">{item.text || payloadText(item.payload)}</Text>,
  plan: (item) => <Text size="sm">{item.text || payloadText(item.payload)}</Text>,
  command_execution: (item) => <Text size="sm">{item.text || payloadValue(item.payload, "command")}</Text>,
  file_change: (item) => <Text size="sm">{item.text || payloadValue(item.payload, "path")}</Text>,
  mcp_tool_call: (item) => <Text size="sm">{item.text || payloadValue(item.payload, "toolName")}</Text>,
  dynamic_tool_call: (item) => <Text size="sm">{item.text || payloadValue(item.payload, "name")}</Text>,
  warning: (item) => (
    <Text size="sm" c="yellow.9">
      {item.text || payloadText(item.payload)}
    </Text>
  ),
  error: (item) => (
    <Text size="sm" c="red.8">
      {item.text || payloadText(item.payload)}
    </Text>
  ),
};

export function TimelineItemRenderer({ item }: { item: TimelineItem }) {
  const render = rendererRegistry[item.kind] ?? unknownRenderer;
  return (
    <Box className="kodex-timeline-item">
      <Group gap="xs">
        <TimelineIcon kind={item.kind} />
        <Badge size="xs" variant="light">
          {item.status}
        </Badge>
        <Text size="xs" c="dimmed">
          {item.kind}
        </Text>
      </Group>
      {render(item)}
    </Box>
  );
}

function TimelineIcon({ kind }: { kind: string }) {
  const size = 15;
  if (kind === "command_execution") {
    return <Terminal size={size} />;
  }
  if (kind === "file_change") {
    return <FileDiff size={size} />;
  }
  if (kind === "plan") {
    return <ListChecks size={size} />;
  }
  if (kind === "mcp_tool_call" || kind === "dynamic_tool_call") {
    return <Wrench size={size} />;
  }
  if (kind === "warning" || kind === "error") {
    return <AlertTriangle size={size} />;
  }
  if (kind === "reasoning") {
    return <Code2 size={size} />;
  }
  return <Bot size={size} />;
}

function unknownRenderer(item: TimelineItem) {
  return <Text size="sm">{item.text || payloadText(item.payload) || item.kind}</Text>;
}

function payloadText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const record = payload as Record<string, unknown>;
  return (
    payloadValue(record, "text") ||
    payloadValue(record, "message") ||
    payloadValue(record, "delta") ||
    JSON.stringify(record)
  );
}

function payloadValue(payload: unknown, key: string): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}
