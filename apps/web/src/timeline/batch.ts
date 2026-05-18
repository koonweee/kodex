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
  return coalesceAdjacentItemDeltas(coalesceProjectionPatches(events), viewRevision);
}

function coalesceProjectionPatches(events: EventEnvelope[]): EventEnvelope[] {
  const latestProjectionPatchSeqByThread = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "timeline.projection_patch") {
      continue;
    }
    const threadKey = event.threadId ?? "__unknown_thread__";
    latestProjectionPatchSeqByThread.set(
      threadKey,
      Math.max(latestProjectionPatchSeqByThread.get(threadKey) ?? Number.NEGATIVE_INFINITY, event.seq),
    );
  }
  return events.filter((event) => {
    if (event.kind !== "timeline.projection_patch") {
      return true;
    }
    const threadKey = event.threadId ?? "__unknown_thread__";
    return event.seq === latestProjectionPatchSeqByThread.get(threadKey);
  });
}

function coalesceAdjacentItemDeltas(events: EventEnvelope[], viewRevision: number): EventEnvelope[] {
  const coalesced: EventEnvelope[] = [];
  for (const event of events) {
    if (event.kind === "timeline.item_delta" && event.seq <= viewRevision) {
      continue;
    }
    const previous = coalesced[coalesced.length - 1];
    if (previous && sameItemDelta(previous, event)) {
      coalesced[coalesced.length - 1] = mergeItemDelta(previous, event);
    } else {
      coalesced.push(event);
    }
  }
  return coalesced;
}

function sameItemDelta(left: EventEnvelope, right: EventEnvelope): boolean {
  return (
    left.kind === "timeline.item_delta" &&
    right.kind === "timeline.item_delta" &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.itemId === right.itemId
  );
}

function mergeItemDelta(left: EventEnvelope, right: EventEnvelope): EventEnvelope {
  const leftPayload = recordPayload(left.payload);
  const rightPayload = recordPayload(right.payload);
  return {
    ...right,
    payload: {
      ...leftPayload,
      ...rightPayload,
      delta: `${stringValue(leftPayload.delta)}${stringValue(rightPayload.delta)}`,
    },
  };
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
