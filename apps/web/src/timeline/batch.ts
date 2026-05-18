import type { EventEnvelope } from "../api/client";
import { applyLiveTimelineUpdate, type TimelineState } from "./reducer";

export function applyTimelineEventBatch(state: TimelineState, events: EventEnvelope[]): TimelineState {
  if (events.length === 0) {
    return state;
  }

  return coalesceTimelineEvents([...events].sort((left, right) => left.seq - right.seq), state.viewRevision).reduce(
    applyLiveTimelineUpdate,
    state,
  );
}

function coalesceTimelineEvents(events: EventEnvelope[], viewRevision: number): EventEnvelope[] {
  return dropThreadViewItemDeltasSupersededByPatches(coalesceThreadViewItemDeltas(coalesceThreadViewPatches(events, viewRevision)));
}

function coalesceThreadViewPatches(events: EventEnvelope[], viewRevision: number): EventEnvelope[] {
  const latestProjectionPatchSeqByThread = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "thread_view.patch" || event.seq <= viewRevision) {
      continue;
    }
    const threadKey = event.threadId ?? "__unknown_thread__";
    latestProjectionPatchSeqByThread.set(
      threadKey,
      Math.max(latestProjectionPatchSeqByThread.get(threadKey) ?? Number.NEGATIVE_INFINITY, event.seq),
    );
  }
  return events.filter((event) => {
    if (event.kind !== "thread_view.patch") {
      return true;
    }
    if (event.seq <= viewRevision) {
      return false;
    }
    const threadKey = event.threadId ?? "__unknown_thread__";
    return event.seq === latestProjectionPatchSeqByThread.get(threadKey);
  });
}

function coalesceThreadViewItemDeltas(events: EventEnvelope[]): EventEnvelope[] {
  const coalesced: EventEnvelope[] = [];
  for (const event of events) {
    const previous = coalesced[coalesced.length - 1];
    if (!previous || event.kind !== "thread_view.item_delta" || previous.kind !== "thread_view.item_delta") {
      coalesced.push(event);
      continue;
    }
    const previousPayload = itemDeltaPayload(previous.payload);
    const payload = itemDeltaPayload(event.payload);
    if (!sameDeltaTarget(previous, event, previousPayload, payload)) {
      coalesced.push(event);
      continue;
    }
    coalesced[coalesced.length - 1] = {
      ...event,
      payload: {
        ...payload,
        delta: `${previousPayload.delta ?? ""}${payload.delta ?? ""}`,
      },
    };
  }
  return coalesced;
}

type ItemDeltaPayload = {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
};

function itemDeltaPayload(payload: unknown): ItemDeltaPayload {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  return payload as ItemDeltaPayload;
}

function sameDeltaTarget(
  left: EventEnvelope,
  right: EventEnvelope,
  leftPayload: ItemDeltaPayload,
  rightPayload: ItemDeltaPayload,
): boolean {
  return (
    (left.threadId ?? leftPayload.threadId) === (right.threadId ?? rightPayload.threadId) &&
    (left.turnId ?? leftPayload.turnId) === (right.turnId ?? rightPayload.turnId) &&
    (left.itemId ?? leftPayload.itemId) === (right.itemId ?? rightPayload.itemId)
  );
}

function dropThreadViewItemDeltasSupersededByPatches(events: EventEnvelope[]): EventEnvelope[] {
  const latestPatchSeqByThread = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "thread_view.patch") {
      continue;
    }
    const threadKey = event.threadId ?? "__unknown_thread__";
    latestPatchSeqByThread.set(
      threadKey,
      Math.max(latestPatchSeqByThread.get(threadKey) ?? Number.NEGATIVE_INFINITY, event.seq),
    );
  }
  if (latestPatchSeqByThread.size === 0) {
    return events;
  }
  return events.filter((event) => {
    if (event.kind !== "thread_view.item_delta") {
      return true;
    }
    const payload = itemDeltaPayload(event.payload);
    const threadKey = event.threadId ?? payload.threadId ?? "__unknown_thread__";
    const latestPatchSeq = latestPatchSeqByThread.get(threadKey);
    return latestPatchSeq === undefined || event.seq > latestPatchSeq;
  });
}
