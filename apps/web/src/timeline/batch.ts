import type { EventEnvelope } from "../api/client";
import { applyLiveTimelineUpdate, type TimelineState } from "./reducer";

export function applyTimelineEventBatch(state: TimelineState, events: EventEnvelope[]): TimelineState {
  if (events.length === 0) {
    return state;
  }

  return coalesceTimelineEventBatch(events).reduce(applyLiveTimelineUpdate, state);
}

export function coalesceTimelineEventBatch(events: EventEnvelope[]): EventEnvelope[] {
  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  const result: EventEnvelope[] = [];
  const turnPatchIndexes = new Map<string, number>();

  for (const event of sorted) {
    const key = turnPatchCoalesceKey(event);
    if (!key) {
      result.push(event);
      continue;
    }
    const existingIndex = turnPatchIndexes.get(key);
    if (existingIndex === undefined) {
      turnPatchIndexes.set(key, result.length);
      result.push(event);
      continue;
    }
    result[existingIndex] = event;
  }

  return result.sort((left, right) => left.seq - right.seq);
}

function turnPatchCoalesceKey(event: EventEnvelope): string | null {
  if (event.kind !== "thread_view.patch") {
    return null;
  }
  const payload = recordPayload(event.payload);
  if (payload?.scope !== "turn") {
    return null;
  }
  const rows = arrayPayload(payload.rows);
  const affectedTurnIds = arrayPayload(payload.affectedTurnIds)
    .map(stringPayload)
    .filter((turnId): turnId is string => Boolean(turnId));
  if (rows.length === 0 || affectedTurnIds.length === 0) {
    return null;
  }
  const threadId = event.threadId ?? stringPayload(payload.threadId);
  if (!threadId) {
    return null;
  }
  return `${threadId}:${affectedTurnIds.sort().join(",")}`;
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayPayload(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringPayload(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
