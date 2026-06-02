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
  const itemDeltaIndexes = new Map<string, number>();

  for (const event of sorted) {
    if (event.kind === "thread_view.patch" || event.kind === "thread_view.refresh_required") {
      itemDeltaIndexes.clear();
    }
    const deltaKey = itemDeltaCoalesceKey(event);
    if (deltaKey) {
      turnPatchIndexes.clear();
      const existingIndex = itemDeltaIndexes.get(deltaKey);
      if (existingIndex === undefined) {
        itemDeltaIndexes.set(deltaKey, result.length);
        result.push(event);
        continue;
      }
      result[existingIndex] = mergeItemDeltaEvents(result[existingIndex], event);
      continue;
    }

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

function itemDeltaCoalesceKey(event: EventEnvelope): string | null {
  if (event.kind !== "thread_view.item_delta") {
    return null;
  }
  const payload = recordPayload(event.payload);
  const threadId = event.threadId ?? stringPayload(payload?.threadId);
  const turnId = event.turnId ?? stringPayload(payload?.turnId);
  const itemId = event.itemId ?? stringPayload(payload?.itemId);
  const delta = stringPayload(payload?.delta);
  if (!threadId || !turnId || !itemId || delta === null) {
    return null;
  }
  return `${threadId}:${turnId}:${itemId}`;
}

function mergeItemDeltaEvents(left: EventEnvelope, right: EventEnvelope): EventEnvelope {
  const leftPayload = recordPayload(left.payload) ?? {};
  const rightPayload = recordPayload(right.payload) ?? {};
  return {
    ...right,
    payload: {
      ...rightPayload,
      delta: `${stringPayload(leftPayload.delta) ?? ""}${stringPayload(rightPayload.delta) ?? ""}`,
    },
  };
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
