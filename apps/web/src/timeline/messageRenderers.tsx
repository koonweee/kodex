import { Box, Text } from "@mantine/core";
import { Check, Copy } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

import { filePreviewUrl } from "../api/client";
import { cssUrl, skillIconUrlIsSvg } from "../composer/skillMentions";
import { fileExtension, filePreviewAction } from "../files/filePreviewActions";
import type { MarkdownPreviewRequest } from "../files/types";
import { ImageThumbnail } from "../images/ImageThumbnail";
import type { ImageLightboxImage } from "../images/types";
import { copyTextToClipboard } from "../shared/clipboard";
import { AdaptiveIconButton } from "../ui/AdaptiveIconButton";
import { LazyMarkdownContent, localPreviewPath } from "./rendererShared";
import type { TimelineImage, TimelineItem } from "./reducer";

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
  const images = item.images ?? [];
  const fileAttachments = item.fileAttachments ?? [];
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
          <Text size="sm" className="kodex-user-message-bubble">
            <InlineSkillMentionText text={item.text} skillMentions={item.skillMentions} />
          </Text>
        ) : null}
        {item.confirmationState && item.confirmationState !== "sent" ? (
          <Text size="xs" className="kodex-user-message-status" data-state={item.confirmationState}>
            {optimisticStatusText(item)}
          </Text>
        ) : null}
        {item.text ? <MessageToolbar align="end" text={item.text} timestampMs={toolbarTimestampMs} /> : null}
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
          <MessageToolbar align="start" text={text} timestampMs={toolbarTimestampMs} />
        ) : null}
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

function InlineSkillMentionText({
  skillMentions,
  text,
}: {
  skillMentions?: TimelineItem["skillMentions"];
  text: string;
}) {
  const mentions = validInlineSkillMentions(text, skillMentions);
  if (mentions.length === 0) {
    return <>{text}</>;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mention of mentions) {
    if (mention.start > cursor) {
      parts.push(text.slice(cursor, mention.start));
    }
    const tokenLabel = text.slice(mention.start, mention.end);
    const accentColor = validCssColor(mention.brandColor);
    const hasDisplayMetadata = skillMentionHasDisplayMetadata(mention, Boolean(accentColor));
    const displayLabel = skillMentionDisplayLabel(tokenLabel, mention, hasDisplayMetadata);
    const title = skillMentionTitle(displayLabel, mention);
    const isSvgIcon = skillIconUrlIsSvg(mention.iconSmallUrl);
    const style = accentColor
      ? ({
          "--skill-accent-color": accentColor,
          "--skill-accent-foreground": skillAccentForeground(accentColor),
        } as CSSProperties)
      : undefined;
    parts.push(
      <span
        aria-label={`${displayLabel} skill`}
        className="kodex-inline-skill-badge"
        data-has-accent={accentColor ? "true" : undefined}
        key={`${mention.path}-${mention.start}-${mention.end}`}
        style={style}
        title={title}
      >
        {mention.iconSmallUrl && isSvgIcon ? (
          <span className="kodex-inline-skill-icon kodex-inline-skill-icon-frame" aria-hidden="true">
            <span
              className="kodex-inline-skill-icon-svg"
              style={{ "--skill-icon-mask": cssUrl(mention.iconSmallUrl) } as CSSProperties}
            />
          </span>
        ) : mention.iconSmallUrl ? (
          <img
            alt=""
            className="kodex-inline-skill-icon"
            src={mention.iconSmallUrl}
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        ) : hasDisplayMetadata ? (
          <span className="kodex-inline-skill-icon kodex-inline-skill-icon-fallback" aria-hidden="true">
            {skillMentionFallbackIconLabel(displayLabel, mention)}
          </span>
        ) : null}
        {displayLabel}
      </span>,
    );
    cursor = mention.end;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return <>{parts}</>;
}

function validInlineSkillMentions(text: string, mentions: TimelineItem["skillMentions"] = []) {
  const valid = mentions
    .filter((mention) =>
      Number.isInteger(mention.start) &&
      Number.isInteger(mention.end) &&
      mention.start >= 0 &&
      mention.end > mention.start &&
      mention.end <= text.length &&
      text.slice(mention.start, mention.end) === `$${mention.name}`,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const output: typeof valid = [];
  let cursor = 0;
  for (const mention of valid) {
    if (mention.start < cursor) {
      return [];
    }
    output.push(mention);
    cursor = mention.end;
  }
  return output;
}

function skillMentionDisplayLabel(
  tokenLabel: string,
  mention: NonNullable<TimelineItem["skillMentions"]>[number],
  hasDisplayMetadata: boolean,
): string {
  return mention.displayName?.trim() || (hasDisplayMetadata ? mention.name : tokenLabel);
}

function skillMentionHasDisplayMetadata(
  mention: NonNullable<TimelineItem["skillMentions"]>[number],
  hasValidAccentColor: boolean,
): boolean {
  return Boolean(
    mention.displayName?.trim() ||
      mention.shortDescription?.trim() ||
      mention.scope?.trim() ||
      mention.iconSmallUrl?.trim() ||
      hasValidAccentColor,
  );
}

function skillMentionFallbackIconLabel(
  displayLabel: string,
  mention: NonNullable<TimelineItem["skillMentions"]>[number],
): string {
  const source = displayLabel.trim() || mention.name.trim();
  return source.match(/[A-Za-z0-9]/)?.[0]?.toLocaleUpperCase() ?? "$";
}

function skillMentionTitle(displayLabel: string, mention: NonNullable<TimelineItem["skillMentions"]>[number]): string {
  const parts = [
    mention.displayName && mention.displayName !== displayLabel ? mention.displayName : null,
    mention.shortDescription,
    mention.scope,
    mention.path,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ") || mention.path || displayLabel;
}

function validCssColor(value?: string | null): string | null {
  const color = value?.trim();
  if (!color || typeof document === "undefined") {
    return null;
  }
  const element = document.createElement("span");
  element.style.color = color;
  return element.style.color ? color : null;
}

function skillAccentForeground(color: string): string {
  const rgb = hexColorToRgb(color);
  if (!rgb) {
    return "var(--kodex-text-on-accent)";
  }
  const [red, green, blue] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.4 ? "#17211f" : "#ffffff";
}

function hexColorToRgb(color: string): [number, number, number] | null {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) {
    return null;
  }
  const expanded =
    hex.length === 3
      ? hex
          .split("")
          .map((digit) => `${digit}${digit}`)
          .join("")
      : hex;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
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
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const meridiem = hours < 12 ? "AM" : "PM";
  return `${displayHours}:${minutes}:${seconds} ${meridiem}`;
}

function localDayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isFinalAssistantMessage(item: TimelineItem): boolean {
  return (item.kind === "assistant_message" || item.kind === "agent_message") && item.messagePhase === "final_answer";
}
