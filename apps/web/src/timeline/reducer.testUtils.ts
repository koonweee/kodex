import { applyTimelineEvent } from "./reducer";

type TimelineEventEnvelope = Parameters<typeof applyTimelineEvent>[1];

function event(overrides: Partial<TimelineEventEnvelope>): TimelineEventEnvelope {
  return {
    id: "event-1",
    seq: 1,
    kind: "codex.notification",
    codexMethod: "item/started",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    projectId: "project-1",
    payload: {},
    receivedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}

export { applyTimelineEvent, event };
