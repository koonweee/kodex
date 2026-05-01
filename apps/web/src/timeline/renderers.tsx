import { Badge, Box, Code, Group, Stack, Text } from "@mantine/core";
import { AlertTriangle, Bot, Code2, FileDiff, Globe, Terminal, User, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import type { TimelineItem, WebSearchAction } from "./reducer";

type TimelineRenderer = (item: TimelineItem) => ReactNode;

const rendererRegistry: Record<string, TimelineRenderer> = {
  agent_message: (item) => <AssistantMessageMarkdown text={item.text || "No assistant content yet"} />,
  assistant_message: (item) => <AssistantMessageMarkdown text={item.text || "No assistant content yet"} />,
  user_message: (item) => <MessageText text={item.text} />,
  reasoning_summary: (item) => <ReasoningBlock item={item} />,
  reasoning: (item) => <ReasoningBlock item={item} />,
  command_execution: (item) => <CommandBlock item={item} />,
  file_change: (item) => <FileChangeBlock item={item} />,
  mcp_tool_call: (item) => <ToolCallBlock item={item} />,
  dynamic_tool_call: (item) => <ToolCallBlock item={item} />,
  web_search_group: (item) => <WebSearchBlock actions={item.actions ?? []} />,
  warning: (item) => (
    <Text size="sm" c="yellow.4">
      {item.text || "Warning"}
    </Text>
  ),
  error: (item) => (
    <Text size="sm" c="red.4">
      {item.text || "Error"}
    </Text>
  ),
  debug_event: (item) => <Text size="sm">{item.text || "Unsupported item"}</Text>,
};

const labels: Record<string, string> = {
  agent_message: "Assistant",
  assistant_message: "Assistant",
  user_message: "You",
  reasoning: "Reasoning",
  reasoning_summary: "Reasoning",
  web_search_group: "Web search",
  command_execution: "Command",
  file_change: "File change",
  mcp_tool_call: "MCP tool",
  dynamic_tool_call: "Tool",
  warning: "Warning",
  error: "Error",
  debug_event: "Debug event",
};

export function TimelineItemRenderer({ item, showDebug = false }: { item: TimelineItem; showDebug?: boolean }) {
  const render = rendererRegistry[item.kind] ?? unknownRenderer;
  const label = labels[item.kind] ?? "Unsupported item";
  const showStatus = item.status !== "completed";
  return (
    <Box className={`kodex-timeline-item kodex-timeline-item-${item.kind}`}>
      <Group gap="xs" wrap="nowrap" className="kodex-timeline-item-header">
        <TimelineIcon kind={item.kind} />
        <Text size="xs" fw={700} className="kodex-timeline-label">
          {label}
        </Text>
        {showStatus ? (
          <Badge size="xs" variant="light" color={statusColor(item.status)}>
            {statusLabel(item.status)}
          </Badge>
        ) : null}
      </Group>
      {render(item)}
      {showDebug ? <DebugDisclosure item={item} /> : null}
    </Box>
  );
}

function unknownRenderer(item: TimelineItem) {
  return <Text size="sm">{item.text || item.kind || "Unsupported item"}</Text>;
}

function MessageText({ text }: { text: string }) {
  return (
    <Text size="sm" className="kodex-timeline-message">
      {text}
    </Text>
  );
}

function AssistantMessageMarkdown({ text }: { text: string }) {
  return (
    <Box className="kodex-assistant-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
          code: ({ children, className }) => {
            const isBlock = Boolean(className);
            return isBlock ? (
              <Code block className="kodex-timeline-code">
                {children}
              </Code>
            ) : (
              <Code className="kodex-assistant-inline-code">{children}</Code>
            );
          },
          p: ({ children }) => (
            <Text component="p" size="sm" className="kodex-assistant-markdown-paragraph">
              {children}
            </Text>
          ),
          pre: ({ children }) => <>{children}</>,
        }}
      >
        {text}
      </ReactMarkdown>
    </Box>
  );
}

function ReasoningBlock({ item }: { item: TimelineItem }) {
  const summary = item.summary || item.text;
  return (
    <details className="kodex-timeline-disclosure">
      <summary>Summary</summary>
      <Text size="sm">{summary}</Text>
    </details>
  );
}

function WebSearchBlock({ actions }: { actions: WebSearchAction[] }) {
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

function CommandBlock({ item }: { item: TimelineItem }) {
  const command = item.command || payloadValue(item.payload, "command");
  const cwd = item.cwd || payloadValue(item.payload, "cwd");
  const output = item.output || payloadValue(item.payload, "output") || payloadValue(item.payload, "stdout") || payloadValue(item.payload, "stderr");
  return (
    <Stack gap={6}>
      {command ? (
        <Code block className="kodex-timeline-code">
          {command}
        </Code>
      ) : (
        <MessageText text={item.text || "Command"} />
      )}
      {cwd ? (
        <Text size="xs" c="dimmed">
          {cwd}
        </Text>
      ) : null}
      {output ? (
        <Code block className="kodex-timeline-output">
          {output}
        </Code>
      ) : null}
    </Stack>
  );
}

function FileChangeBlock({ item }: { item: TimelineItem }) {
  const action = item.action || payloadValue(item.payload, "action");
  const path = item.path || payloadValue(item.payload, "path");
  return (
    <Group gap="xs" wrap="wrap" className="kodex-timeline-inline-row">
      {action ? <Badge size="xs" variant="light">{action}</Badge> : null}
      <Text size="sm">{path || item.text || "File change"}</Text>
    </Group>
  );
}

function ToolCallBlock({ item }: { item: TimelineItem }) {
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

function DebugDisclosure({ item }: { item: TimelineItem }) {
  return (
    <details className="kodex-timeline-debug">
      <summary>Debug details</summary>
      <Stack gap={8} mt={8}>
        {item.debugEvents.map((event) => (
          <Box key={event.id}>
            <Text size="xs" c="dimmed">
              {event.codexMethod ?? event.kind}
              {event.itemId ? ` · ${event.itemId}` : ""}
            </Text>
            <Code block className="kodex-timeline-debug-payload">
              {JSON.stringify(event.payload, null, 2)}
            </Code>
          </Box>
        ))}
      </Stack>
    </details>
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
  if (kind === "mcp_tool_call" || kind === "dynamic_tool_call") {
    return <Wrench size={size} />;
  }
  if (kind === "warning" || kind === "error") {
    return <AlertTriangle size={size} />;
  }
  if (kind === "reasoning" || kind === "reasoning_summary") {
    return <Code2 size={size} />;
  }
  if (kind === "web_search_group") {
    return <Globe size={size} />;
  }
  if (kind === "user_message") {
    return <User size={size} />;
  }
  return <Bot size={size} />;
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

function payloadValue(payload: unknown, key: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const record = payload as Record<string, unknown>;
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function statusLabel(status: TimelineItem["status"]): string {
  if (status === "approval_required") {
    return "approval required";
  }
  return status;
}

function statusColor(status: TimelineItem["status"]): string {
  if (status === "failed") {
    return "red";
  }
  if (status === "waiting" || status === "approval_required") {
    return "yellow";
  }
  if (status === "cancelled") {
    return "gray";
  }
  return "teal";
}
