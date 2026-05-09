import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import { applyTimelineEventBatch } from "./batch";
import { applyTimelineEvent, createTimelineState } from "./reducer";

function event(overrides: Partial<EventEnvelope>): EventEnvelope {
  return {
    id: "event-1",
    seq: 1,
    kind: "timeline.item_delta",
    codexMethod: "item/agentMessage/delta",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "answer-1",
    projectId: "project-1",
    payload: { source: "gatewayStream", delta: "Hello", rawPayload: { delta: "Hello" } },
    receivedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}

describe("timeline event batching", () => {
  it("produces the same final timeline state as sequential sorted updates", () => {
    const events = [
      event({ id: "event-3", seq: 3, payload: { source: "gatewayStream", delta: "!", rawPayload: { delta: "!" } } }),
      event({ id: "event-1", seq: 1, payload: { source: "gatewayStream", delta: "Hello", rawPayload: { delta: "Hello" } } }),
      event({ id: "event-2", seq: 2, payload: { source: "gatewayStream", delta: " world", rawPayload: { delta: " world" } } }),
    ];

    const expected = [...events]
      .sort((left, right) => left.seq - right.seq)
      .reduce(applyTimelineEvent, createTimelineState());

    expect(applyTimelineEventBatch(createTimelineState(), events)).toEqual(expected);
    expect(applyTimelineEventBatch(createTimelineState(), events).items[0]).toMatchObject({
      id: "answer-1",
      displayOrder: 1,
      text: "Hello world!",
    });
  });

  it("does not mutate the queued event array", () => {
    const events = [
      event({ id: "event-2", seq: 2, payload: { source: "gatewayStream", delta: " second", rawPayload: { delta: " second" } } }),
      event({ id: "event-1", seq: 1, payload: { source: "gatewayStream", delta: "First", rawPayload: { delta: "First" } } }),
    ];
    const originalOrder = events.map((queuedEvent) => queuedEvent.id);

    applyTimelineEventBatch(createTimelineState(), events);

    expect(events.map((queuedEvent) => queuedEvent.id)).toEqual(originalOrder);
  });
});
