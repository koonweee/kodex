import { Box, Code, Stack, Text } from "@mantine/core";
import {
  AlertTriangle,
  Bot,
  Check,
  ClipboardList,
  Code2,
  FileDiff,
  Globe,
  ImageIcon,
  Info,
  Terminal,
  Wrench,
} from "lucide-react";
import { lazy, Suspense } from "react";

import type { MarkdownContentProps } from "../markdown/MarkdownContent";
import type { TimelineItem } from "./reducer";

const MarkdownContent = lazy(() =>
  import("../markdown/MarkdownContent").then((module) => ({ default: module.MarkdownContent })),
);

export const timelineItemLabels: Record<string, string> = {
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

export function MessageText({ text }: { text: string }) {
  return (
    <Text size="sm" className="kodex-timeline-message">
      {text}
    </Text>
  );
}

export function LazyMarkdownContent({
  fallbackText,
  ...props
}: MarkdownContentProps & {
  fallbackText: string;
}) {
  return (
    <Suspense fallback={<MessageText text={fallbackText} />}>
      <MarkdownContent {...props} />
    </Suspense>
  );
}

export function DebugDisclosure({ item }: { item: TimelineItem }) {
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

export function TimelineIcon({ kind }: { kind: string }) {
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

export function unknownRenderer(item: TimelineItem) {
  return <Text size="sm">{item.text || item.kind || "Unsupported item"}</Text>;
}

export function isTimelineMessage(kind: string) {
  return kind === "agent_message" || kind === "assistant_message" || kind === "user_message";
}

export function payloadValue(payload: unknown, key: string): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const record = payload as Record<string, unknown>;
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function displayCommand(command: string): string {
  const trimmed = command.trim();
  const shellMatch = trimmed.match(/^\/usr\/bin\/(?:zsh|bash|sh)\s+-lc\s+(["'])([\s\S]*)\1$/);
  return shellMatch?.[2] ?? trimmed;
}

export function sentenceCase(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

export function titleCase(value: string): string {
  const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
  return spaced.replace(/\b\w/g, (match) => match.toUpperCase());
}

export function localPreviewPath(path?: string): string | null {
  return path && isLocalAbsolutePath(path) ? path : null;
}

export function displayableImageSrc(path?: string): string | null {
  if (!path) {
    return null;
  }
  return /^(?:https?:|blob:|data:image\/)/.test(path) ? path : null;
}

export function statusLabel(status: TimelineItem["status"]): string {
  if (status === "approval_required") {
    return "approval required";
  }
  return status;
}

export function statusTone(status: TimelineItem["status"]): "danger" | "info" | "neutral" | "success" | "warning" {
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

export function commandStatusMeta(status: TimelineItem["status"]):
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

function isLocalAbsolutePath(path: string): boolean {
  return /^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(path);
}
