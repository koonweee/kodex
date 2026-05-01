import { Badge, Box, Code, Group, Stack, Text } from "@mantine/core";
import { AlertTriangle, Check, ChevronRight, Code2, FileDiff, Globe, Terminal, Wrench } from "lucide-react";
import { memo } from "react";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import type { TimelineItem, WebSearchAction } from "./reducer";

type TimelineRendererOptions = {
  imagePreviewUrlsByPath: Record<string, string>;
};
type TimelineRenderer = (item: TimelineItem, options: TimelineRendererOptions) => ReactNode;

const rendererRegistry: Record<string, TimelineRenderer> = {
  agent_message: (item) => <AssistantMessageMarkdown itemId={item.id} text={item.text || "No assistant content yet"} />,
  assistant_message: (item) => <AssistantMessageMarkdown itemId={item.id} text={item.text || "No assistant content yet"} />,
  user_message: (item, options) => <UserMessageBubble item={item} imagePreviewUrlsByPath={options.imagePreviewUrlsByPath} />,
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

const assistantMarkdownRemarkPlugins = [remarkGfm, remarkBreaks];

const assistantMarkdownComponents: Components = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  code: ({ children, className }) => {
    const isBlock = Boolean(className) || String(children).includes("\n");
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
};

type TimelineItemRendererProps = {
  item: TimelineItem;
  imagePreviewUrlsByPath?: Record<string, string>;
  showDebug?: boolean;
};

function TimelineItemRendererImpl({ item, imagePreviewUrlsByPath = {}, showDebug = false }: TimelineItemRendererProps) {
  const render = rendererRegistry[item.kind] ?? unknownRenderer;
  const label = labels[item.kind] ?? "Unsupported item";
  const showStatus = item.status !== "completed";
  const isMessage = isTimelineMessage(item.kind);
  return (
    <Box className={`kodex-timeline-item kodex-timeline-item-${item.kind}`}>
      {!isMessage || showStatus ? (
        <Group gap="xs" wrap="nowrap" className="kodex-timeline-item-header" data-message-status={isMessage ? "true" : undefined}>
          {!isMessage ? (
            <>
              <TimelineIcon kind={item.kind} />
              <Text size="xs" fw={700} className="kodex-timeline-label">
                {label}
              </Text>
            </>
          ) : null}
          {showStatus ? (
            <Badge size="xs" variant="light" color={statusColor(item.status)}>
              {statusLabel(item.status)}
            </Badge>
          ) : null}
        </Group>
      ) : null}
      {render(item, { imagePreviewUrlsByPath })}
      {showDebug ? <DebugDisclosure item={item} /> : null}
    </Box>
  );
}

export const TimelineItemRenderer = memo(TimelineItemRendererImpl);
TimelineItemRenderer.displayName = "TimelineItemRenderer";

type TimelineActivityGroupRendererProps = {
  items: TimelineItem[];
  showDebug?: boolean;
};

function TimelineActivityGroupRendererImpl({
  items,
  showDebug = false,
}: TimelineActivityGroupRendererProps) {
  return (
    <details className="kodex-activity-group">
      <summary>
        <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
          <Terminal size={15} />
          <Text size="sm" fw={700} className="kodex-activity-group-title" title={activityGroupSummary(items)}>
            {activityGroupSummary(items)}
          </Text>
        </Group>
        <ChevronRight size={16} className="kodex-activity-caret" aria-hidden="true" />
      </summary>
      <Stack gap={8} mt={8}>
        {items.map((item) => (
          <ActivityItemRenderer item={item} key={item.id} showDebug={showDebug} />
        ))}
      </Stack>
    </details>
  );
}

export const TimelineActivityGroupRenderer = memo(TimelineActivityGroupRendererImpl);
TimelineActivityGroupRenderer.displayName = "TimelineActivityGroupRenderer";

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

function UserMessageBubble({
  imagePreviewUrlsByPath,
  item,
}: {
  imagePreviewUrlsByPath: Record<string, string>;
  item: TimelineItem;
}) {
  const images = item.images ?? [];
  return (
    <Box className="kodex-user-message-row">
      <Box className="kodex-user-message-stack">
        {images.length > 0 ? (
          <Box className="kodex-user-image-grid">
            {images.map((image, index) => {
              const src = image.url ?? (image.path ? imagePreviewUrlsByPath[image.path] : undefined);
              return src ? <img alt="" key={`${src}-${index}`} src={src} /> : null;
            })}
          </Box>
        ) : null}
        {item.text ? (
          <Text size="sm" className="kodex-user-message-bubble">
            {item.text}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

const AssistantMessageMarkdown = memo(
  function AssistantMessageMarkdown({ text }: { itemId: string; text: string }) {
    return (
      <Box className="kodex-assistant-markdown">
        <ReactMarkdown remarkPlugins={assistantMarkdownRemarkPlugins} skipHtml components={assistantMarkdownComponents}>
          {text}
        </ReactMarkdown>
      </Box>
    );
  },
  (prev, next) => prev.itemId === next.itemId && prev.text === next.text,
);
AssistantMessageMarkdown.displayName = "AssistantMessageMarkdown";

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

const ActivityItemRenderer = memo(function ActivityItemRenderer({ item, showDebug }: { item: TimelineItem; showDebug: boolean }) {
  const render = rendererRegistry[item.kind] ?? unknownRenderer;
  if (item.kind === "command_execution") {
    return (
      <details className="kodex-activity-item">
        <summary>
          <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
            <Text size="sm" className="kodex-activity-title" title={commandSummary(item)}>
              {commandSummary(item)}
            </Text>
          </Group>
          <ChevronRight size={16} className="kodex-activity-caret" aria-hidden="true" />
        </summary>
        <CommandBlock item={item} />
        {showDebug ? <DebugDisclosure item={item} /> : null}
      </details>
    );
  }

  return (
    <details className="kodex-activity-item">
      <summary>
        <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
          <TimelineIcon kind={item.kind} />
          <Text size="sm" className="kodex-activity-title" title={activityItemSummary(item)}>
            {activityItemSummary(item)}
          </Text>
        </Group>
        <ChevronRight size={16} className="kodex-activity-caret" aria-hidden="true" />
      </summary>
      <Box className="kodex-activity-body">{render(item, { imagePreviewUrlsByPath: {} })}</Box>
      {showDebug ? <DebugDisclosure item={item} /> : null}
    </details>
  );
});
ActivityItemRenderer.displayName = "ActivityItemRenderer";

function CommandBlock({ item }: { item: TimelineItem }) {
  const command = item.command || payloadValue(item.payload, "command");
  const output = item.output || payloadValue(item.payload, "output") || payloadValue(item.payload, "stdout") || payloadValue(item.payload, "stderr");
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
      {output ? (
        <Code block className="kodex-timeline-output">
          {output}
        </Code>
      ) : null}
      {item.status === "completed" ? (
        <Text size="xs" c="dimmed" className="kodex-activity-status">
          <Check size={13} /> Success
        </Text>
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
  return <Code2 size={size} />;
}

function isTimelineMessage(kind: string) {
  return kind === "agent_message" || kind === "assistant_message" || kind === "user_message";
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

function activityGroupSummary(items: TimelineItem[]): string {
  const commandCount = items.filter((item) => item.kind === "command_execution").length;
  const fileCount = items.filter((item) => item.kind === "file_change").length;
  const webCount = items.filter((item) => item.kind === "web_search_group").length;
  const toolCount = items.filter((item) => item.kind === "mcp_tool_call" || item.kind === "dynamic_tool_call").length;
  const parts = [
    webCount ? "Searched web" : "",
    fileCount ? fileCount === 1 ? "changed 1 file" : `changed ${fileCount} files` : "",
    toolCount ? toolCount === 1 ? "used 1 tool" : `used ${toolCount} tools` : "",
    commandCount ? commandCount === 1 ? "ran 1 command" : `ran ${commandCount} commands` : "",
  ].filter(Boolean);
  return parts.length ? sentenceCase(parts.join(", ")) : "Worked";
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
    return path ? `Changed ${path}` : "Changed files";
  }
  if (item.kind === "web_search_group") {
    const count = item.actions?.length ?? 0;
    return count === 1 ? "Searched web" : `Searched web, ${count} actions`;
  }
  if (item.kind === "mcp_tool_call" || item.kind === "dynamic_tool_call") {
    return item.toolName ? `Used ${item.toolName}` : "Used tool";
  }
  return labels[item.kind] ?? "Activity";
}

function displayCommand(command: string): string {
  const trimmed = command.trim();
  const shellMatch = trimmed.match(/^\/usr\/bin\/(?:zsh|bash|sh)\s+-lc\s+(["'])([\s\S]*)\1$/);
  return shellMatch?.[2] ?? trimmed;
}

function sentenceCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
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
