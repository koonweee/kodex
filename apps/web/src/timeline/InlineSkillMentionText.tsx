import type { CSSProperties, ReactNode } from "react";

import { cssUrl, skillIconUrlIsSvg } from "../composer/skillMentions";
import type { TimelineItem } from "./reducer";

export function InlineSkillMentionText({
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
