import type { EventEnvelope, RateLimitSnapshot, RateLimitWindow, RateLimitsResponse } from "../api/client";

export type UsageLimitLines = {
  primary: string;
  secondary?: string;
};

type RateLimitsUpdatedPayload = {
  rateLimits?: unknown;
};

export function usageLimitSnapshotFromResponse(response: RateLimitsResponse): RateLimitSnapshot | null {
  if (response.rateLimits) {
    return response.rateLimits;
  }

  const byLimitId = response.rateLimitsByLimitId;
  if (!byLimitId) {
    return null;
  }

  return byLimitId.codex ?? Object.values(byLimitId)[0] ?? null;
}

export function usageLimitSnapshotFromEvent(event: EventEnvelope): RateLimitSnapshot | null {
  if (event.kind !== "codex.notification" || event.codexMethod !== "account/rateLimits/updated") {
    return null;
  }

  if (!isObject(event.payload)) {
    return null;
  }

  const payload = event.payload as RateLimitsUpdatedPayload;
  return isRateLimitSnapshot(payload.rateLimits) ? payload.rateLimits : null;
}

export function formatUsageLimitLines(snapshot: RateLimitSnapshot | null, now = new Date()): UsageLimitLines | null {
  if (!snapshot?.primary) {
    return null;
  }

  const primary = formatUsageLimitLine(snapshot.primary, "5h", now);
  if (!primary) {
    return null;
  }

  const secondary = snapshot.secondary ? formatUsageLimitLine(snapshot.secondary, "7d", now) : null;
  return {
    primary,
    ...(secondary ? { secondary } : {}),
  };
}

function formatUsageLimitLine(window: RateLimitWindow, fallbackLabel: string, now: Date) {
  const percentLeft = formatPercentLeft(window.usedPercent);
  const resetAt = formatResetAt(window.resetsAt, now);
  if (!resetAt) {
    return `${durationLabel(window.windowDurationMins, fallbackLabel)} ${percentLeft} left`;
  }

  return `${durationLabel(window.windowDurationMins, fallbackLabel)} ${percentLeft} left - ${resetAt}`;
}

function formatPercentLeft(usedPercent: number) {
  return `${Math.round(clamp(100 - usedPercent, 0, 100))}%`;
}

function durationLabel(windowDurationMins: number | null | undefined, fallbackLabel: string) {
  if (!windowDurationMins || !Number.isFinite(windowDurationMins) || windowDurationMins <= 0) {
    return fallbackLabel;
  }

  if (windowDurationMins % (60 * 24) === 0) {
    return `${windowDurationMins / (60 * 24)}d`;
  }

  if (windowDurationMins % 60 === 0) {
    return `${windowDurationMins / 60}h`;
  }

  return fallbackLabel;
}

function formatResetAt(resetsAt: number | null | undefined, now: Date) {
  if (!resetsAt) {
    return null;
  }

  const resetDate = new Date(resetsAt * 1000);
  if (Number.isNaN(resetDate.getTime())) {
    return null;
  }

  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(resetDate);

  if (isSameLocalDate(resetDate, now)) {
    return time;
  }

  const date = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "long",
  }).format(resetDate);
  return `${time} (${date})`;
}

function isSameLocalDate(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

function isRateLimitSnapshot(value: unknown): value is RateLimitSnapshot {
  return isObject(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
