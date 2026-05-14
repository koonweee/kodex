import type { EventEnvelope } from "../api/client";
import type { TimelineItem, TimelineStatus } from "./state";

export function createBaseItem(event: EventEnvelope, id: string, kind: string, status: TimelineStatus): TimelineItem {
  const timestampMs = eventReceivedAtMs(event);
  return {
    id,
    kind,
    status,
    text: "",
    turnId: event.turnId ?? null,
    displayOrder: event.seq,
    timestampMs,
    payload: event.payload,
    debugEvents: [event],
  };
}

function eventReceivedAtMs(event: EventEnvelope): number | undefined {
  const parsed = Date.parse(event.receivedAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function eventStatus(event: EventEnvelope): TimelineStatus {
  const payload = payloadRecord(event.payload);
  const item = eventItem(event);
  const status = (stringValue(item.status) || stringValue(item.phase) || stringValue(payload?.status)).toLowerCase();
  if (status.includes("fail") || status.includes("error")) {
    return "failed";
  }
  if (status.includes("wait")) {
    return "waiting";
  }
  if (status.includes("cancel")) {
    return "cancelled";
  }
  if (status.includes("approval")) {
    return "approval_required";
  }
  if (status === "completed" || status === "complete") {
    return "completed";
  }
  if (event.codexMethod === "item/completed" || event.codexMethod === "turn/completed") {
    return "completed";
  }
  return "running";
}

export function isLifecycleEvent(event: EventEnvelope): boolean {
  if (event.itemId) {
    return false;
  }
  const method = event.codexMethod ?? "";
  return (
    method.startsWith("turn/") ||
    method.startsWith("thread/") ||
    method.includes("token") ||
    method.includes("usage") ||
    !method
  );
}

export function isWarningEvent(event: EventEnvelope): boolean {
  const source = `${event.kind} ${event.codexMethod ?? ""}`.toLowerCase();
  return source.includes("warning") || source.includes("warn");
}

export function isErrorEvent(event: EventEnvelope): boolean {
  const source = `${event.kind} ${event.codexMethod ?? ""}`.toLowerCase();
  return source.includes("error") || source.includes("failed");
}

export function eventItem(event: EventEnvelope): Record<string, unknown> {
  const payload = payloadRecord(event.payload);
  return payloadRecord(payload?.item) ?? payload ?? {};
}

export function eventPayloadItem(payload: unknown): Record<string, unknown> {
  const record = payloadRecord(payload);
  return payloadRecord(record?.item) ?? record ?? {};
}

export function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 4).map(summarizeValue).filter(Boolean).join(", ");
  }
  const record = payloadRecord(value);
  if (!record) {
    return "";
  }
  const entries = Object.entries(record).slice(0, 4);
  return entries.map(([key, entry]) => `${key}: ${summarizeValue(entry)}`).join(", ");
}

export function contentArrayText(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      const record = payloadRecord(entry);
      const type = stringValue(record?.type).toLowerCase();
      if (["image", "input_image", "inputimage", "local_image", "localimage", "mention", "skill"].includes(type)) {
        return "";
      }
      return textValue(record?.text) || textValue(record?.content);
    })
    .filter(Boolean)
    .join("\n");
}

export function truncateSummary(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

export function uniqueValues(values: string[]): string[] {
  return [...new Set(values)];
}

export function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
}
