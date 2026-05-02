import type { EventEnvelope } from "../api/client";
import { applyLiveTimelineUpdate, type TimelineState } from "./reducer";

export function applyTimelineEventBatch(state: TimelineState, events: EventEnvelope[]): TimelineState {
  if (events.length === 0) {
    return state;
  }

  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .reduce(applyLiveTimelineUpdate, state);
}
