import type { EventEnvelope } from "../api/client";
import { applyTimelineEvent, type TimelineState } from "./reducer";

export function applyTimelineEventBatch(state: TimelineState, events: EventEnvelope[]): TimelineState {
  if (events.length === 0) {
    return state;
  }

  return [...events]
    .sort((left, right) => left.seq - right.seq)
    .reduce(applyTimelineEvent, state);
}
