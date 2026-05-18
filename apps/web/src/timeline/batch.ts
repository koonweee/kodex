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
  return coalesceThreadViewPatches(events, viewRevision);
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
