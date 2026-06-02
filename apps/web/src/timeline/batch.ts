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
  const rowDeltaPatchIndexes = new Map<string, number>();
  const itemDeltaIndexes = new Map<string, number>();

  for (const event of sorted) {
    if (event.kind === "thread_view.refresh_required" || isNonRowDeltaThreadViewPatch(event)) {
      itemDeltaIndexes.clear();
      rowDeltaPatchIndexes.clear();
    }
    if (
      event.kind === "thread_view.refresh_required" ||
      event.kind === "thread_view.item_delta" ||
      isRowDeltaThreadViewPatch(event) ||
      isNonTurnThreadViewPatch(event)
    ) {
      turnPatchIndexes.clear();
    }
    const deltaKey = itemDeltaCoalesceKey(event);
    if (deltaKey) {
      rowDeltaPatchIndexes.clear();
      const existingIndex = itemDeltaIndexes.get(deltaKey);
      if (existingIndex === undefined) {
        itemDeltaIndexes.set(deltaKey, result.length);
        result.push(event);
        continue;
      }
      result[existingIndex] = mergeItemDeltaEvents(result[existingIndex], event);
      continue;
    }

    const rowDeltaKey = rowDeltaPatchCoalesceKey(event);
    if (rowDeltaKey) {
      itemDeltaIndexes.clear();
      const existingIndex = rowDeltaPatchIndexes.get(rowDeltaKey);
      if (existingIndex === undefined) {
        rowDeltaPatchIndexes.set(rowDeltaKey, result.length);
        result.push(event);
        continue;
      }
      result[existingIndex] = mergeRowDeltaPatchEvents(result[existingIndex], event);
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

function isRowDeltaThreadViewPatch(event: EventEnvelope): boolean {
  if (event.kind !== "thread_view.patch") {
    return false;
  }
  return recordPayload(event.payload)?.scope === "row_delta";
}

function isNonRowDeltaThreadViewPatch(event: EventEnvelope): boolean {
  if (event.kind !== "thread_view.patch") {
    return false;
  }
  return recordPayload(event.payload)?.scope !== "row_delta";
}

function isNonTurnThreadViewPatch(event: EventEnvelope): boolean {
  if (event.kind !== "thread_view.patch") {
    return false;
  }
  return recordPayload(event.payload)?.scope !== "turn";
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

function rowDeltaPatchCoalesceKey(event: EventEnvelope): string | null {
  if (event.kind !== "thread_view.patch") {
    return null;
  }
  const payload = recordPayload(event.payload);
  if (payload?.scope !== "row_delta") {
    return null;
  }
  const threadId = event.threadId ?? stringPayload(payload.threadId);
  if (!threadId) {
    return null;
  }
  const rows = arrayPayload(payload.rows);
  const removedRowIds = rowIdsPayload(payload.removedRowIds);
  if (rows.length === 0 && removedRowIds.length === 0) {
    return null;
  }
  const affectedTurnIds = rowIdsPayload(payload.affectedTurnIds);
  if (affectedTurnIds.length === 0) {
    return null;
  }
  return `${threadId}:${affectedTurnIds.sort().join(",")}`;
}

function mergeRowDeltaPatchEvents(left: EventEnvelope, right: EventEnvelope): EventEnvelope {
  const leftPayload = recordPayload(left.payload) ?? {};
  const rightPayload = recordPayload(right.payload) ?? {};
  const rowsById = new Map<string, unknown>();
  const removedRowIds = new Set<string>();
  const affectedTurnIds = new Set<string>([
    ...rowIdsPayload(leftPayload.affectedTurnIds),
    ...rowIdsPayload(rightPayload.affectedTurnIds),
  ]);

  for (const row of arrayPayload(leftPayload.rows)) {
    const rowId = rowIdPayload(row);
    if (!rowId) {
      continue;
    }
    rowsById.set(rowId, row);
    removedRowIds.delete(rowId);
  }
  for (const rowId of rowIdsPayload(leftPayload.removedRowIds)) {
    rowsById.delete(rowId);
    removedRowIds.add(rowId);
  }
  for (const row of arrayPayload(rightPayload.rows)) {
    const rowId = rowIdPayload(row);
    if (!rowId) {
      continue;
    }
    rowsById.set(rowId, row);
    removedRowIds.delete(rowId);
  }
  for (const rowId of rowIdsPayload(rightPayload.removedRowIds)) {
    rowsById.delete(rowId);
    removedRowIds.add(rowId);
  }

  return {
    ...right,
    payload: {
      ...rightPayload,
      affectedTurnIds: [...affectedTurnIds],
      rows: [...rowsById.values()],
      removedRowIds: [...removedRowIds],
    },
  };
}

function recordPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayPayload(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rowIdPayload(value: unknown): string | null {
  return stringPayload(recordPayload(value)?.id);
}

function rowIdsPayload(value: unknown): string[] {
  return arrayPayload(value)
    .map(stringPayload)
    .filter((id): id is string => Boolean(id));
}

function stringPayload(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
