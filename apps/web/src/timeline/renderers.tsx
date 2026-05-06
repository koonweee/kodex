import { Badge, Box, Code, Group, Stack, Text } from "@mantine/core";
import { AlertTriangle, Bot, Check, ChevronRight, ClipboardList, Code2, Copy, FileDiff, Globe, ImageIcon, Info, Terminal, Wrench } from "lucide-react";
import { Children, isValidElement, memo, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, ReactNode, SyntheticEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { filePreviewUrl } from "../api/client";
import type { MarkdownPreviewRequest } from "../files/types";
import { ImageThumbnail } from "../images/ImageThumbnail";
import type { ImageLightboxImage } from "../images/types";
import { copyTextToClipboard } from "./clipboard";
import type { TimelineActivityRow, TimelineItemRow, TimelineWorkRow } from "./derive";
import { FileDiffViewer } from "./FileDiffViewer";
import type { TimelineItem, WebSearchAction } from "./reducer";

type TimelineRendererOptions = {
  imagePreviewUrlsByPath: Record<string, string>;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  threadId?: string;
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
    />
  ),
  assistant_message: (item, options) => (
    <AssistantMessageMarkdown
      item={item}
      onImageOpen={options.onImageOpen}
      onMarkdownOpen={options.onMarkdownOpen}
      text={item.text || "No assistant content yet"}
      threadId={options.threadId}
    />
  ),
  user_message: (item, options) => (
    <UserMessageBubble
      item={item}
      imagePreviewUrlsByPath={options.imagePreviewUrlsByPath}
      onImageOpen={options.onImageOpen}
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
  collab_agent_tool_call: "Agent",
  plan: "Plan",
  image_view: "Image",
  image_generation: "Generated image",
  review_mode_started: "Review",
  review_mode_finished: "Review",
  context_compaction: "Context",
  warning: "Warning",
  error: "Error",
  debug_event: "Debug event",
};

const assistantMarkdownRemarkPlugins = [remarkGfm, remarkBreaks];

function assistantMarkdownComponents(
  threadId?: string,
  onImageOpen?: (image: ImageLightboxImage) => void,
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void,
): Components {
  return {
    a: ({ children, href, title }) => {
      const imagePreview = localImagePreviewHref(threadId, href);
      const markdownPreview = localMarkdownPreviewHref(threadId, href);
      if (imagePreview) {
        return (
          <a
            href={imagePreview.href}
            target="_blank"
            rel="noreferrer"
            onClick={(event) => {
              if (!onImageOpen || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                return;
              }
              event.preventDefault();
              onImageOpen({ alt: "", src: imagePreview.href, title: title ?? imagePreview.path });
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a
          href={markdownPreview?.href ?? href}
          target="_blank"
          rel="noreferrer"
          download={onMarkdownOpen ? undefined : markdownPreview?.download}
          onClick={(event) => {
            if (!markdownPreview || !onMarkdownOpen || shouldUseNativeLinkClick(event)) {
              return;
            }
            event.preventDefault();
            onMarkdownOpen({
              fragment: markdownPreview.fragment,
              href: markdownPreview.href,
              column: markdownPreview.column,
              line: markdownPreview.line,
              path: markdownPreview.path,
              title: title ?? markdownPreview.title,
            });
          }}
        >
          {children}
        </a>
      );
    },
    code: ({ children, className }) => {
      const isBlock = Boolean(className) || String(children).includes("\n");
      return isBlock ? (
        <AssistantCodeBlock>{children}</AssistantCodeBlock>
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
}

function AssistantCodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const copyText = useMemo(() => codeBlockClipboardText(children), [children]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    const copied = await copyTextToClipboard(copyText);
    if (!copied) {
      return;
    }
    setCopied(true);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 1_300);
  }

  return (
    <Box className="kodex-code-block-shell">
      <Code block className="kodex-timeline-code">
        {children}
      </Code>
      <button
        aria-label={copied ? "Copied code" : "Copy code"}
        className="kodex-ui-button kodex-ui-icon-button kodex-code-copy-button"
        onClick={handleCopy}
        title={copied ? "Copied code" : "Copy code"}
        type="button"
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </Box>
  );
}

function codeBlockClipboardText(children: ReactNode): string {
  const text = reactNodeText(children);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function reactNodeText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (isValidElement<{ children?: ReactNode }>(child)) {
        return reactNodeText(child.props.children);
      }
      return "";
    })
    .join("");
}

type TimelineItemRendererProps = {
  item: TimelineItem;
  imagePreviewUrlsByPath?: Record<string, string>;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  showDebug?: boolean;
  threadId?: string;
};

function TimelineItemRendererImpl({
  item,
  imagePreviewUrlsByPath = {},
  onImageOpen,
  onMarkdownOpen,
  showDebug = false,
  threadId,
}: TimelineItemRendererProps) {
  const render = rendererRegistry[item.kind] ?? unknownRenderer;
  const label = labels[item.kind] ?? "Unsupported item";
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
            <Badge className="kodex-ui-badge" data-tone={statusTone(item.status)} size="xs" variant="light">
              {statusLabel(item.status)}
            </Badge>
          ) : null}
        </Group>
      ) : null}
      {render(item, { imagePreviewUrlsByPath, onImageOpen, onMarkdownOpen, threadId })}
      {showDebug ? <DebugDisclosure item={item} /> : null}
    </Box>
  );
}

export const TimelineItemRenderer = memo(TimelineItemRendererImpl);
TimelineItemRenderer.displayName = "TimelineItemRenderer";

type TimelineActivityGroupRendererProps = {
  imagePreviewUrlsByPath?: Record<string, string>;
  items: TimelineItem[];
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  showDebug?: boolean;
  threadId?: string;
};

function TimelineActivityGroupRendererImpl({
  imagePreviewUrlsByPath = {},
  items,
  onImageOpen,
  onMarkdownOpen,
  showDebug = false,
  threadId,
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
      </Stack>
    </details>
  );
}

export const TimelineActivityGroupRenderer = memo(TimelineActivityGroupRendererImpl);
TimelineActivityGroupRenderer.displayName = "TimelineActivityGroupRenderer";

type TimelineWorkRowRendererProps = {
  imagePreviewUrlsByPath: Record<string, string>;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  row: TimelineWorkRow;
  showDebug?: boolean;
  threadId?: string;
};

function TimelineWorkRowRendererImpl({
  imagePreviewUrlsByPath,
  onImageOpen,
  onMarkdownOpen,
  row,
  showDebug = false,
  threadId,
}: TimelineWorkRowRendererProps) {
  const elapsedMs = useWorkElapsedMs(row);
  const label = `${row.state === "running" ? "Working" : "Worked"} for ${fmtElapsedCompact(Math.floor(elapsedMs / 1_000))}`;

  if (row.state === "running") {
    return (
      <Box className="kodex-work-row" data-state="running">
        <Text size="sm" c="dimmed">
          {label}
        </Text>
        <WorkHeaderDivider />
      </Box>
    );
  }

  if (row.collapsedRows.length === 0) {
    return (
      <Box className="kodex-work-row" data-state="completed">
        <Text size="sm" c="dimmed">
          {label}
        </Text>
        <WorkHeaderDivider />
      </Box>
    );
  }

  return (
    <details className="kodex-work-row" data-state="completed">
      <summary>
        <Box className="kodex-work-summary-content">
          <Text size="sm" c="dimmed">
            {label}
          </Text>
          <ChevronRight size={16} className="kodex-work-caret" aria-hidden="true" />
        </Box>
        <WorkHeaderDivider />
      </summary>
      <Stack gap={8} mt={8} className="kodex-work-collapsed-rows">
        {row.collapsedRows.map((collapsedRow) => (
          <CollapsedWorkRowRenderer
            imagePreviewUrlsByPath={imagePreviewUrlsByPath}
            key={collapsedRow.key}
            onImageOpen={onImageOpen}
            onMarkdownOpen={onMarkdownOpen}
            row={collapsedRow}
            showDebug={showDebug}
            threadId={threadId}
          />
        ))}
      </Stack>
    </details>
  );
}

export const TimelineWorkRowRenderer = memo(TimelineWorkRowRendererImpl);
TimelineWorkRowRenderer.displayName = "TimelineWorkRowRenderer";

function WorkHeaderDivider() {
  return <Box aria-hidden="true" className="kodex-timeline-final-response-divider kodex-work-header-divider" />;
}

function CollapsedWorkRowRenderer({
  imagePreviewUrlsByPath,
  onImageOpen,
  onMarkdownOpen,
  row,
  showDebug,
  threadId,
}: {
  imagePreviewUrlsByPath: Record<string, string>;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  row: TimelineItemRow | TimelineActivityRow;
  showDebug: boolean;
  threadId?: string;
}) {
  if (row.type === "activity") {
    return (
      <TimelineActivityGroupRenderer
        imagePreviewUrlsByPath={imagePreviewUrlsByPath}
        items={row.items}
        onImageOpen={onImageOpen}
        onMarkdownOpen={onMarkdownOpen}
        showDebug={showDebug}
        threadId={threadId}
      />
    );
  }
  return (
    <TimelineItemRenderer
      item={row.item}
      imagePreviewUrlsByPath={imagePreviewUrlsByPath}
      onImageOpen={onImageOpen}
      onMarkdownOpen={onMarkdownOpen}
      showDebug={showDebug}
      threadId={threadId}
    />
  );
}

function unknownRenderer(item: TimelineItem) {
  return <Text size="sm">{item.text || item.kind || "Unsupported item"}</Text>;
}

function useWorkElapsedMs(row: TimelineWorkRow): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (row.state !== "running") {
      return;
    }
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [row.state, row.startedAtMs]);
  if (row.state === "completed") {
    return Math.max(0, (row.completedAtMs ?? row.startedAtMs) - row.startedAtMs);
  }
  return Math.max(0, now - row.startedAtMs);
}

function fmtElapsedCompact(elapsedSecs: number): string {
  if (elapsedSecs < 60) {
    return `${elapsedSecs}s`;
  }
  if (elapsedSecs < 3600) {
    const minutes = Math.floor(elapsedSecs / 60);
    const seconds = elapsedSecs % 60;
    return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  }
  const hours = Math.floor(elapsedSecs / 3600);
  const minutes = Math.floor((elapsedSecs % 3600) / 60);
  const seconds = elapsedSecs % 60;
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
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
  onImageOpen,
}: {
  imagePreviewUrlsByPath: Record<string, string>;
  item: TimelineItem;
  onImageOpen?: (image: ImageLightboxImage) => void;
}) {
  const images = item.images ?? [];
  return (
    <Box className="kodex-user-message-row">
      <Box className="kodex-user-message-stack">
        {images.length > 0 ? (
          <Box className="kodex-user-image-grid">
            {images.map((image, index) => {
              const src = image.url ?? (image.path ? imagePreviewUrlsByPath[image.path] : undefined);
              return src ? (
                <ImageThumbnail
                  alt=""
                  key={`${src}-${index}`}
                  src={src}
                  title={image.path}
                  onOpen={onImageOpen}
                />
              ) : null;
            })}
          </Box>
        ) : null}
        {item.text ? (
          <Text size="sm" className="kodex-user-message-bubble">
            {item.text}
          </Text>
        ) : null}
        {item.confirmationState && item.confirmationState !== "sent" ? (
          <Text size="xs" className="kodex-user-message-status" data-state={item.confirmationState}>
            {optimisticStatusText(item)}
          </Text>
        ) : null}
        {item.text ? <MessageCopyToolbar align="end" text={item.text} /> : null}
      </Box>
    </Box>
  );
}

function optimisticStatusText(item: TimelineItem): string {
  if (item.confirmationState === "uploading") {
    return "Uploading";
  }
  if (item.confirmationState === "sending") {
    return "Sending";
  }
  if (item.confirmationState === "failed") {
    return item.error ? `Failed: ${item.error}` : "Failed";
  }
  return "";
}

const AssistantMessageMarkdown = memo(
  function AssistantMessageMarkdown({
    item,
    onImageOpen,
    onMarkdownOpen,
    text,
    threadId,
  }: {
    item: TimelineItem;
    onImageOpen?: (image: ImageLightboxImage) => void;
    onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
    text: string;
    threadId?: string;
  }) {
    const components = useMemo(
      () => assistantMarkdownComponents(threadId, onImageOpen, onMarkdownOpen),
      [onImageOpen, onMarkdownOpen, threadId],
    );
    return (
      <Box className="kodex-assistant-message-stack">
        <Box className="kodex-assistant-markdown">
          <ReactMarkdown remarkPlugins={assistantMarkdownRemarkPlugins} skipHtml components={components}>
            {text}
          </ReactMarkdown>
        </Box>
        {isFinalAssistantMessage(item) ? <MessageCopyToolbar align="start" text={text} /> : null}
      </Box>
    );
  },
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.item.kind === next.item.kind &&
    prev.item.messagePhase === next.item.messagePhase &&
    prev.onImageOpen === next.onImageOpen &&
    prev.onMarkdownOpen === next.onMarkdownOpen &&
    prev.threadId === next.threadId &&
    prev.text === next.text,
);
AssistantMessageMarkdown.displayName = "AssistantMessageMarkdown";

function MessageCopyToolbar({ align, text }: { align: "end" | "start"; text: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  async function handleCopy() {
    const copied = await copyTextToClipboard(text);
    if (!copied) {
      return;
    }
    setCopied(true);
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 1_300);
  }

  return (
    <Box className="kodex-message-toolbar" data-align={align}>
      <button
        aria-label={copied ? "Copied message" : "Copy message"}
        className="kodex-ui-button kodex-ui-icon-button kodex-message-copy-button"
        onClick={handleCopy}
        type="button"
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </Box>
  );
}

function isFinalAssistantMessage(item: TimelineItem): boolean {
  return item.kind === "assistant_message" && item.messagePhase === "final_answer";
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
  const render = rendererRegistry[item.kind] ?? unknownRenderer;
  const [isOpen, setIsOpen] = useState(false);
  const handleToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setIsOpen(event.currentTarget.open);
  };

  if (item.kind === "command_execution") {
    const status = commandStatusMeta(item.status);
    return (
      <details className="kodex-activity-item" onToggle={handleToggle}>
        <summary>
          <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
            <Terminal size={15} />
            <Text size="sm" className="kodex-activity-title" title={commandSummary(item)}>
              {commandSummary(item)}
            </Text>
            {status ? (
              <Badge className="kodex-ui-badge" data-tone={status.tone} size="xs" variant="light">
                {status.label}
              </Badge>
            ) : null}
          </Group>
          <ChevronRight size={16} className="kodex-activity-caret" aria-hidden="true" />
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
      <summary>
        <Group gap="xs" wrap="nowrap" className="kodex-activity-heading">
          <TimelineIcon kind={item.kind} />
          <Text size="sm" className="kodex-activity-title" title={activityItemSummary(item)}>
            {activityItemSummary(item)}
          </Text>
        </Group>
        <ChevronRight size={16} className="kodex-activity-caret" aria-hidden="true" />
      </summary>
      {isOpen ? (
        <>
          <Box className="kodex-activity-body">{render(item, { imagePreviewUrlsByPath, onImageOpen, onMarkdownOpen, threadId })}</Box>
          {showDebug ? <DebugDisclosure item={item} /> : null}
        </>
      ) : null}
    </details>
  );
});
ActivityItemRenderer.displayName = "ActivityItemRenderer";

function CommandBlock({ item }: { item: TimelineItem }) {
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
      {output ? (
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

function FileChangeBlock({ item }: { item: TimelineItem }) {
  const path = item.path || payloadValue(item.payload, "path");
  if (item.output) {
    return <FileDiffViewer diff={item.output} path={path || undefined} />;
  }
  return (
    <Stack gap={6} className="kodex-file-change-block">
      <Text size="sm">File change</Text>
    </Stack>
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

function CollabAgentBlock({
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
                      className="kodex-ui-badge kodex-collab-agent-status"
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
        <Badge key={chip} className="kodex-ui-badge" data-tone={chip === "Failed" ? "danger" : "neutral"} size="xs" variant="light">
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
  const components = useMemo(() => assistantMarkdownComponents(threadId, undefined, onMarkdownOpen), [onMarkdownOpen, threadId]);
  return (
    <Box className="kodex-collab-agent-markdown kodex-assistant-markdown">
      <ReactMarkdown remarkPlugins={assistantMarkdownRemarkPlugins} skipHtml components={components}>
        {text}
      </ReactMarkdown>
    </Box>
  );
}

function PlanBlock({ item }: { item: TimelineItem }) {
  return <Text size="sm">{item.text || "Plan updated"}</Text>;
}

function ImageActivityBlock({
  item,
  onImageOpen,
  threadId,
}: {
  item: TimelineItem;
  onImageOpen?: (image: ImageLightboxImage) => void;
  threadId?: string;
}) {
  const directSrc = displayableImageSrc(item.imageSrc) ?? displayableImageSrc(item.path);
  const previewPath = localPreviewPath(item.path) ?? localPreviewPath(item.imageSrc);
  const src = directSrc ?? (threadId && previewPath ? filePreviewUrl(threadId, previewPath) : null);
  const title = item.imageSrc ? item.path || item.text : item.path;
  const metadata = imageActivityMetadata(item);
  return (
    <Stack gap={4}>
      {src ? (
        <Box className="kodex-activity-image-preview">
          <ImageActivityThumbnail src={src} title={title} onImageOpen={onImageOpen} />
        </Box>
      ) : (
        <ImagePreviewUnavailable
          path={item.path ? undefined : previewPath ?? undefined}
          title={item.text || "Image activity"}
        />
      )}
      {item.kind === "image_generation" ? (
        <ImageActivityDetails metadata={metadata} />
      ) : (
        <ImageActivityInlineMetadata metadata={metadata} />
      )}
    </Stack>
  );
}

function imageActivityMetadata(item: TimelineItem): Array<{ label: string; value: string }> {
  return [
    item.path ? { label: "Path", value: item.path } : null,
    item.resultSummary ? { label: "Prompt", value: item.resultSummary } : null,
    item.output ? { label: "Result", value: item.output } : null,
  ].filter((entry): entry is { label: string; value: string } => entry !== null);
}

function ImageActivityInlineMetadata({ metadata }: { metadata: Array<{ label: string; value: string }> }) {
  if (metadata.length === 0) {
    return null;
  }
  return (
    <>
      {metadata.map((entry) => (
        <Text size="xs" c="dimmed" className="kodex-timeline-inline-row" key={entry.label}>
          {entry.label}: {entry.value}
        </Text>
      ))}
    </>
  );
}

function ImageActivityDetails({ metadata }: { metadata: Array<{ label: string; value: string }> }) {
  if (metadata.length === 0) {
    return null;
  }
  return (
    <details className="kodex-image-activity-details">
      <summary>
        <Text size="xs" c="dimmed">
          Details
        </Text>
        <ChevronRight size={14} className="kodex-image-activity-details-caret" aria-hidden="true" />
      </summary>
      <Stack gap={4} mt={4}>
        {metadata.map((entry) => (
          <Text size="xs" c="dimmed" className="kodex-timeline-inline-row" key={entry.label}>
            {entry.label}: {entry.value}
          </Text>
        ))}
      </Stack>
    </details>
  );
}

function ImageActivityThumbnail({
  onImageOpen,
  src,
  title,
}: {
  onImageOpen?: (image: ImageLightboxImage) => void;
  src: string;
  title?: string;
}) {
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    setLoadFailed(false);
  }, [src]);

  if (loadFailed) {
    return <ImagePreviewUnavailable title="Preview unavailable" />;
  }

  const content = <img alt="" src={src} title={title} onError={() => setLoadFailed(true)} />;
  return (
    <Box className="kodex-image-thumbnail">
      {onImageOpen ? (
        <button
          aria-label={title ? `Open ${title}` : "Open image"}
          className="kodex-image-thumbnail-button"
          type="button"
          onClick={() => onImageOpen({ alt: "", src, title })}
        >
          {content}
        </button>
      ) : (
        content
      )}
    </Box>
  );
}

function ImagePreviewUnavailable({ path, title }: { path?: string; title: string }) {
  return (
    <Stack gap={2} className="kodex-activity-image-unavailable">
      <Text size="sm">{title}</Text>
      {path ? (
        <Text size="xs" c="dimmed" className="kodex-timeline-inline-row">
          {path}
        </Text>
      ) : null}
    </Stack>
  );
}

function displayableImageSrc(path?: string): string | null {
  if (!path) {
    return null;
  }
  return /^(?:https?:|blob:|data:image\/)/.test(path) ? path : null;
}

function localPreviewPath(path?: string): string | null {
  return path && isLocalAbsolutePath(path) ? path : null;
}

function localMarkdownPreviewHref(
  threadId?: string,
  href?: string,
): {
  column?: number;
  download: string;
  fragment: string;
  href: string;
  line?: number;
  path: string;
  title: string;
} | null {
  const target = href ? localMarkdownPreviewTarget(href) : null;
  if (!threadId || !target) {
    return null;
  }
  const download = markdownFileName(target.path);
  return {
    column: target.column,
    download,
    fragment: target.fragment,
    href: `${filePreviewUrl(threadId, target.path)}${target.fragment}`,
    line: target.line,
    path: target.path,
    title: markdownLocationTitle(download, target.line, target.column),
  };
}

function localImagePreviewHref(threadId?: string, href?: string): { href: string; path: string } | null {
  const target = href ? localImagePreviewTarget(href) : null;
  if (!threadId || !target) {
    return null;
  }
  return {
    href: filePreviewUrl(threadId, target.path),
    path: target.path,
  };
}

function localMarkdownPreviewTarget(href: string): { column?: number; fragment: string; line?: number; path: string } | null {
  const { fragment, path } = localFilePreviewTarget(href);
  const target = localMarkdownPathWithLocation(path);
  if (!target) {
    return null;
  }
  return { ...target, fragment };
}

function localImagePreviewTarget(href: string): { path: string } | null {
  const { path } = localFilePreviewTarget(href);
  if (!isLocalImagePath(path)) {
    return null;
  }
  return { path };
}

function localFilePreviewTarget(href: string): { fragment: string; path: string } {
  const hashIndex = href.indexOf("#");
  const pathWithQuery = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const fragment = hashIndex >= 0 ? href.slice(hashIndex) : "";
  const queryIndex = pathWithQuery.indexOf("?");
  const path = queryIndex >= 0 ? pathWithQuery.slice(0, queryIndex) : pathWithQuery;
  return { fragment, path };
}

function isLocalMarkdownPath(path: string): boolean {
  return isLocalAbsolutePath(path) && /\.(?:md|markdown)$/i.test(path);
}

function localMarkdownPathWithLocation(path: string): { column?: number; line?: number; path: string } | null {
  if (isLocalMarkdownPath(path)) {
    return { path };
  }
  const match = path.match(/^(.+\.(?:md|markdown)):([1-9]\d*)(?::([1-9]\d*))?$/i);
  if (!match || !isLocalMarkdownPath(match[1])) {
    return null;
  }
  return {
    column: match[3] ? Number(match[3]) : undefined,
    line: Number(match[2]),
    path: match[1],
  };
}

function isLocalImagePath(path: string): boolean {
  return isLocalAbsolutePath(path) && /\.(?:png|jpe?g|gif|webp)$/i.test(path);
}

function isLocalAbsolutePath(path: string): boolean {
  return /^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(path);
}

function markdownFileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "preview.md";
}

function markdownLocationTitle(fileName: string, line?: number, column?: number): string {
  if (!line) {
    return fileName;
  }
  return column ? `${fileName}:${line}:${column}` : `${fileName}:${line}`;
}

function shouldUseNativeLinkClick(event: MouseEvent<HTMLAnchorElement>) {
  return event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

function StatusMarker({ item }: { item: TimelineItem }) {
  return (
    <Text size="sm" c="dimmed" className="kodex-timeline-inline-row">
      {item.text}
    </Text>
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
  if (kind === "collab_agent_tool_call") {
    return <Bot size={size} />;
  }
  if (kind === "image_view" || kind === "image_generation") {
    return <ImageIcon size={size} />;
  }
  if (kind === "plan") {
    return <ClipboardList size={size} />;
  }
  if (kind === "review_mode_started" || kind === "review_mode_finished" || kind === "context_compaction") {
    return <Info size={size} />;
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
  const agentCount = collabAgentCount(items);
  const generatedImageCount = items.filter((item) => item.kind === "image_generation").length;
  const viewedImageCount = items.filter((item) => item.kind === "image_view").length;
  const parts = [
    webCount ? "Searched web" : "",
    fileCount ? fileCount === 1 ? "changed 1 file" : `changed ${fileCount} files` : "",
    toolCount ? toolCount === 1 ? "used 1 tool" : `used ${toolCount} tools` : "",
    agentCount ? agentCount === 1 ? "used 1 agent" : `used ${agentCount} agents` : "",
    generatedImageCount ? generatedImageCount === 1 ? "generated 1 image" : `generated ${generatedImageCount} images` : "",
    viewedImageCount ? viewedImageCount === 1 ? "viewed 1 image" : `viewed ${viewedImageCount} images` : "",
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
  if (item.kind === "collab_agent_tool_call") {
    return collabActivitySummary(item);
  }
  if (item.kind === "image_view" || item.kind === "image_generation") {
    return item.text || "Image activity";
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

function collabActivitySummary(item: TimelineItem): string {
  if (item.toolName === "wait" && item.status === "running" && item.collab && item.collab.agents.length > 1) {
    return `Waiting for ${item.collab.agents.length} agents`;
  }
  if (item.text) {
    return item.text;
  }
  return "Agent activity";
}

function collabAgentCount(items: TimelineItem[]): number {
  const agentIds = new Set<string>();
  let fallbackRows = 0;
  for (const item of items) {
    if (item.kind !== "collab_agent_tool_call") {
      continue;
    }
    if (!item.collab?.agents.length) {
      fallbackRows += 1;
      continue;
    }
    for (const agent of item.collab.agents) {
      agentIds.add(agent.threadId);
    }
  }
  return agentIds.size || fallbackRows;
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

function titleCase(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.replace(/\b\w/g, (match) => match.toUpperCase());
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

function statusTone(status: TimelineItem["status"]): "danger" | "info" | "neutral" | "success" | "warning" {
  if (status === "failed") {
    return "danger";
  }
  if (status === "running") {
    return "info";
  }
  if (status === "waiting" || status === "approval_required") {
    return "warning";
  }
  if (status === "cancelled") {
    return "neutral";
  }
  return "success";
}

function commandStatusMeta(status: TimelineItem["status"]):
  | { Icon: typeof AlertTriangle; label: string; tone: ReturnType<typeof statusTone> }
  | { Icon: typeof Check; label: string; tone: ReturnType<typeof statusTone> }
  | null {
  if (status === "completed") {
    return { Icon: Check, label: "Success", tone: "success" };
  }
  if (status === "failed") {
    return { Icon: AlertTriangle, label: "Failed", tone: "danger" };
  }
  if (status === "cancelled") {
    return { Icon: AlertTriangle, label: "Cancelled", tone: "neutral" };
  }
  if (status === "approval_required") {
    return { Icon: AlertTriangle, label: "Approval required", tone: "warning" };
  }
  if (status === "waiting") {
    return { Icon: AlertTriangle, label: "Waiting", tone: "warning" };
  }
  return null;
}
