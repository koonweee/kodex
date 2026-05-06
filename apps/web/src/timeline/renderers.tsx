import { Badge, Box, Code, Group, Stack, Text } from "@mantine/core";
import { AlertTriangle, Bot, Check, ChevronRight, ClipboardList, Code2, Copy, FileDiff, Globe, ImageIcon, Info, Terminal, Wrench } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { filePreviewUrl } from "../api/client";
import { ImageThumbnail } from "../images/ImageThumbnail";
import type { ImageLightboxImage } from "../images/types";
import { copyTextToClipboard } from "./clipboard";
import type { TimelineActivityRow, TimelineItemRow, TimelineWorkRow } from "./derive";
import type { TimelineItem, WebSearchAction } from "./reducer";

type TimelineRendererOptions = {
  imagePreviewUrlsByPath: Record<string, string>;
  onImageOpen?: (image: ImageLightboxImage) => void;
  threadId?: string;
};
type TimelineRenderer = (item: TimelineItem, options: TimelineRendererOptions) => ReactNode;

const rendererRegistry: Record<string, TimelineRenderer> = {
  agent_message: (item, options) => (
    <AssistantMessageMarkdown item={item} text={item.text || "No assistant content yet"} threadId={options.threadId} />
  ),
  assistant_message: (item, options) => (
    <AssistantMessageMarkdown item={item} text={item.text || "No assistant content yet"} threadId={options.threadId} />
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
  collab_agent_tool_call: (item) => <CollabAgentBlock item={item} />,
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

function assistantMarkdownComponents(threadId?: string): Components {
  return {
    a: ({ children, href }) => {
      const markdownPreview = localMarkdownPreviewHref(threadId, href);
      return (
        <a
          href={markdownPreview?.href ?? href}
          target="_blank"
          rel="noreferrer"
          download={markdownPreview?.download}
        >
          {children}
        </a>
      );
    },
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
}

type TimelineItemRendererProps = {
  item: TimelineItem;
  imagePreviewUrlsByPath?: Record<string, string>;
  onImageOpen?: (image: ImageLightboxImage) => void;
  showDebug?: boolean;
  threadId?: string;
};

function TimelineItemRendererImpl({
  item,
  imagePreviewUrlsByPath = {},
  onImageOpen,
  showDebug = false,
  threadId,
}: TimelineItemRendererProps) {
  const render = rendererRegistry[item.kind] ?? unknownRenderer;
  const label = labels[item.kind] ?? "Unsupported item";
  const isMessage = isTimelineMessage(item.kind);
  const showStatus = !isMessage && item.status !== "completed";
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
            <Badge className="kodex-ui-badge" data-tone={statusTone(item.status)} size="xs" variant="light">
              {statusLabel(item.status)}
            </Badge>
          ) : null}
        </Group>
      ) : null}
      {render(item, { imagePreviewUrlsByPath, onImageOpen, threadId })}
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
  showDebug?: boolean;
  threadId?: string;
};

function TimelineActivityGroupRendererImpl({
  imagePreviewUrlsByPath = {},
  items,
  onImageOpen,
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
  row: TimelineWorkRow;
  showDebug?: boolean;
  threadId?: string;
};

function TimelineWorkRowRendererImpl({
  imagePreviewUrlsByPath,
  onImageOpen,
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
  row,
  showDebug,
  threadId,
}: {
  imagePreviewUrlsByPath: Record<string, string>;
  onImageOpen?: (image: ImageLightboxImage) => void;
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
  function AssistantMessageMarkdown({ item, text, threadId }: { item: TimelineItem; text: string; threadId?: string }) {
    const components = useMemo(() => assistantMarkdownComponents(threadId), [threadId]);
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
  showDebug,
  threadId,
}: {
  imagePreviewUrlsByPath: Record<string, string>;
  item: TimelineItem;
  onImageOpen?: (image: ImageLightboxImage) => void;
  showDebug: boolean;
  threadId?: string;
}) {
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
      <Box className="kodex-activity-body">{render(item, { imagePreviewUrlsByPath, onImageOpen, threadId })}</Box>
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
      {action ? (
        <Badge className="kodex-ui-badge" data-tone="neutral" size="xs" variant="light">
          {action}
        </Badge>
      ) : null}
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

function CollabAgentBlock({ item }: { item: TimelineItem }) {
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

function localMarkdownPreviewHref(threadId?: string, href?: string): { download: string; href: string } | null {
  const target = href ? localMarkdownPreviewTarget(href) : null;
  if (!threadId || !target) {
    return null;
  }
  return {
    download: markdownFileName(target.path),
    href: `${filePreviewUrl(threadId, target.path)}${target.fragment}`,
  };
}

function localMarkdownPreviewTarget(href: string): { fragment: string; path: string } | null {
  const hashIndex = href.indexOf("#");
  const pathWithQuery = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const fragment = hashIndex >= 0 ? href.slice(hashIndex) : "";
  const queryIndex = pathWithQuery.indexOf("?");
  const path = queryIndex >= 0 ? pathWithQuery.slice(0, queryIndex) : pathWithQuery;
  if (!isLocalMarkdownPath(path)) {
    return null;
  }
  return { fragment, path };
}

function isLocalMarkdownPath(path: string): boolean {
  return isLocalAbsolutePath(path) && /\.(?:md|markdown)$/i.test(path);
}

function isLocalAbsolutePath(path: string): boolean {
  return /^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(path);
}

function markdownFileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || "preview.md";
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
  const agentCount = items.filter((item) => item.kind === "collab_agent_tool_call").length;
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
    return item.text || "Agent activity";
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
