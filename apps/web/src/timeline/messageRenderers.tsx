import { Box, Text } from "@mantine/core";
import { Check, Copy } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { filePreviewUrl } from "../api/client";
import { fileExtension, filePreviewAction } from "../files/filePreviewActions";
import type { MarkdownPreviewRequest } from "../files/types";
import { ImageThumbnail } from "../images/ImageThumbnail";
import type { ImageLightboxImage } from "../images/types";
import { copyTextToClipboard } from "../shared/clipboard";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { LazyMarkdownContent, localPreviewPath } from "./rendererShared";
import type { TimelineImage, TimelineItem } from "./reducer";
import { InlineSkillMentionText } from "./InlineSkillMentionText";
import { parseResponseAnnotations } from "./responseAnnotations";
import { UserMessageAnnotations, annotationMessageCopyText } from "./UserMessageAnnotations";

export function UserMessageBubble({
  imagePreviewUrlsByPath,
  item,
  onImageOpen,
  onMarkdownOpen,
  threadId,
  toolbarTimestampMs,
}: {
  imagePreviewUrlsByPath: Record<string, string>;
  item: TimelineItem;
  onImageOpen?: (image: ImageLightboxImage) => void;
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  threadId?: string;
  toolbarTimestampMs?: number;
}) {
  const parsedAnnotations = parseResponseAnnotations(item.text);
  const copyText = parsedAnnotations ? annotationMessageCopyText(parsedAnnotations) : item.text;
  const images = item.images ?? [];
  const fileAttachments = item.fileAttachments ?? [];
  const statusText = optimisticStatusText(item);
  return (
    <Box className="kodex-user-message-row">
      <Box className="kodex-user-message-stack">
        {images.length > 0 ? (
          <Box className="kodex-user-image-grid">
            {images.map((image, index) => {
              const src = userMessageImageSrc(image, imagePreviewUrlsByPath, threadId);
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
        {fileAttachments.length > 0 ? (
          <Box className="kodex-user-file-grid">
            {fileAttachments.map((attachment) => (
              <UserFileAttachmentTile
                attachment={attachment}
                key={attachment.id}
                onMarkdownOpen={onMarkdownOpen}
                threadId={threadId}
              />
            ))}
          </Box>
        ) : null}
        {item.text ? (
          <Text component="div" size="sm" className="kodex-user-message-bubble">
            {parsedAnnotations ? <UserMessageAnnotations message={parsedAnnotations} skillMentions={item.skillMentions} />
              : <InlineSkillMentionText text={item.text} skillMentions={item.skillMentions} />}
          </Text>
        ) : null}
        {statusText ? (
          <Text size="xs" className="kodex-user-message-status" data-state={item.confirmationState}>
            {statusText}
          </Text>
        ) : null}
        {item.text ? <MessageToolbar align="end" text={copyText} timestampMs={toolbarTimestampMs} /> : null}
      </Box>
    </Box>
  );
}

function UserFileAttachmentTile({
  attachment,
  onMarkdownOpen,
  threadId,
}: {
  attachment: NonNullable<TimelineItem["fileAttachments"]>[number];
  onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
  threadId?: string;
}) {
  const content = (
    <>
      <Text component="span" className="kodex-file-attachment-extension">
        {fileExtensionLabel(attachment)}
      </Text>
      <Text component="span" className="kodex-file-attachment-name">
        {attachment.fileName}
      </Text>
    </>
  );
  const className = "kodex-file-attachment-tile kodex-user-file-tile kodex-file-attachment-action";
  if (!threadId) {
    return (
      <Box className="kodex-file-attachment-tile kodex-user-file-tile" title={attachment.fileName}>
        {content}
      </Box>
    );
  }
  const action = filePreviewAction(threadId, attachment);
  if (action.kind === "markdown" && onMarkdownOpen) {
    return (
      <button
        aria-label={`Preview ${attachment.fileName}`}
        className={className}
        onClick={() => onMarkdownOpen(action.request)}
        title={attachment.fileName}
        type="button"
      >
        {content}
      </button>
    );
  }
  if (action.kind === "pdf") {
    return (
      <a
        aria-label={`Open ${attachment.fileName}`}
        className={className}
        href={action.href}
        rel="noreferrer"
        target="_blank"
        title={attachment.fileName}
      >
        {content}
      </a>
    );
  }
  const href = action.kind === "download" ? action.href : action.request.href;
  const fileName = action.kind === "download" ? action.fileName : attachment.fileName;
  return (
    <a
      aria-label={`Download ${attachment.fileName}`}
      className={className}
      download={fileName}
      href={href}
      title={attachment.fileName}
    >
      {content}
    </a>
  );
}

function fileExtensionLabel(attachment: NonNullable<TimelineItem["fileAttachments"]>[number]): string {
  return (fileExtension(attachment) || "FILE").slice(0, 5).toUpperCase();
}

export const AssistantMessageMarkdown = memo(
  function AssistantMessageMarkdown({
    item,
    onImageOpen,
    onMarkdownOpen,
    text,
    threadId,
    toolbarTimestampMs,
  }: {
    item: TimelineItem;
    onImageOpen?: (image: ImageLightboxImage) => void;
    onMarkdownOpen?: (request: MarkdownPreviewRequest) => void;
    text: string;
    threadId?: string;
    toolbarTimestampMs?: number;
  }) {
    return (
      <Box className="kodex-assistant-message-stack">
        <LazyMarkdownContent
          className="kodex-assistant-markdown"
          fallbackText={text}
          onImageOpen={onImageOpen}
          onMarkdownOpen={onMarkdownOpen}
          text={text}
          threadId={threadId}
        />
        {isFinalAssistantMessage(item) ? (
          <div
            className="kodex-assistant-message-footer"
            aria-hidden={item.status === "running" || undefined}
            inert={item.status === "running" || undefined}
            style={{ visibility: item.status === "running" ? "hidden" : undefined }}
          >
            <MessageToolbar align="start" text={text} timestampMs={toolbarTimestampMs} />
          </div>
        ) : null}
      </Box>
    );
  },
  (prev, next) =>
    prev.item.id === next.item.id &&
    prev.item.kind === next.item.kind &&
    prev.item.messagePhase === next.item.messagePhase &&
    prev.item.status === next.item.status &&
    prev.onImageOpen === next.onImageOpen &&
    prev.onMarkdownOpen === next.onMarkdownOpen &&
    prev.threadId === next.threadId &&
    prev.toolbarTimestampMs === next.toolbarTimestampMs &&
    prev.text === next.text,
);
AssistantMessageMarkdown.displayName = "AssistantMessageMarkdown";

function userMessageImageSrc(
  image: TimelineImage,
  imagePreviewUrlsByPath: Record<string, string>,
  threadId?: string,
): string | undefined {
  if (image.url) {
    return image.url;
  }
  if (!image.path) {
    return undefined;
  }
  return (
    imagePreviewUrlsByPath[image.path] ??
    (threadId && localPreviewPath(image.path) ? filePreviewUrl(threadId, image.path) : undefined)
  );
}

function optimisticStatusText(item: TimelineItem): string {
  if (item.confirmationState === "uploading") {
    return "Uploading";
  }
  if (item.confirmationState === "failed") {
    return item.error ? `Failed: ${item.error}` : "Failed";
  }
  return "";
}

function MessageToolbar({
  align,
  text,
  timestampMs,
}: {
  align: "end" | "start";
  text: string;
  timestampMs?: number;
}) {
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

  const copyLabel = copied ? "Copied message" : "Copy message";
  const copyButton = (
    <AdaptiveIconButton
      className="kodex-message-copy-button"
      density="compact"
      key="copy"
      label={copyLabel}
      onClick={handleCopy}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </AdaptiveIconButton>
  );
  const timestamp = timestampMs !== undefined ? <MessageToolbarTimestamp key="timestamp" timestampMs={timestampMs} /> : null;
  const items = align === "end" ? [timestamp, copyButton] : [copyButton, timestamp];

  return (
    <Box className="kodex-message-toolbar" data-align={align}>
      {items}
    </Box>
  );
}

function MessageToolbarTimestamp({ timestampMs }: { timestampMs: number }) {
  const date = new Date(timestampMs);
  const label = formatMessageToolbarTimestamp(date, new Date());
  if (!label) {
    return null;
  }
  return (
    <span
      aria-label={`Message timestamp ${date.toLocaleString()}`}
      className="kodex-message-toolbar-item kodex-message-timestamp"
      title={date.toLocaleString()}
    >
      {label}
    </span>
  );
}

function formatMessageToolbarTimestamp(date: Date, now: Date): string {
  if (!Number.isFinite(date.getTime())) {
    return "";
  }
  const time = formatMessageToolbarTime(date);
  const dateDay = localDayStart(date).getTime();
  const nowDay = localDayStart(now).getTime();
  const dayDiff = Math.max(0, Math.floor((nowDay - dateDay) / 86_400_000));
  if (dayDiff === 0) {
    return time;
  }
  if (dayDiff === 1) {
    return `yesterday ${time}`;
  }
  return `${dayDiff}d ago ${time}`;
}

function formatMessageToolbarTime(date: Date): string {
  const hours = date.getHours();
  const displayHours = hours % 12 || 12;
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const meridiem = hours < 12 ? "AM" : "PM";
  return `${displayHours}:${minutes} ${meridiem}`;
}

function localDayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isFinalAssistantMessage(item: TimelineItem): boolean {
  return (item.kind === "assistant_message" || item.kind === "agent_message") && item.messagePhase === "final_answer";
}
