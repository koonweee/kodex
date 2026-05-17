import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import { applyTimelineEventBatch } from "./batch";
import { applyLiveTimelineUpdate, createTimelineState } from "./reducer";

function event(overrides: Partial<EventEnvelope> & { text?: string }): EventEnvelope {
  const seq = overrides.seq ?? 1;
  const text = overrides.text ?? "Hello";
  const { text: _text, ...eventOverrides } = overrides;
  return {
    id: "event-1",
    seq,
    kind: "timeline.projection_patch",
    codexMethod: "timeline/projection_patch",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: null,
    projectId: "project-1",
    payload: {
      revision: seq,
      threadId: "thread-1",
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [
        {
          id: "projection-turn-1-answer-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "answer-1",
          itemType: "agentMessage",
          displayOrder: 1,
          status: "running",
          timestampMs: 1,
          payload: {
            source: "gatewayStream",
            turnId: "turn-1",
            itemId: "answer-1",
            item: { id: "answer-1", type: "agentMessage", text },
            itemSnapshot: {
              id: "answer-1",
              itemType: "agentMessage",
              rawPayload: { id: "answer-1", type: "agentMessage", text },
            },
          },
        },
      ],
    },
    receivedAt: "2026-04-30T00:00:00Z",
    ...eventOverrides,
  };
}

describe("timeline event batching", () => {
  it("produces the same final timeline state as sequential sorted updates", () => {
    const events = [
      event({ id: "event-3", seq: 3, text: "Hello world!" }),
      event({ id: "event-1", seq: 1, text: "Hello" }),
      event({ id: "event-2", seq: 2, text: "Hello world" }),
    ];

    const expected = [...events]
      .sort((left, right) => left.seq - right.seq)
      .reduce(applyLiveTimelineUpdate, createTimelineState());

    expect(applyTimelineEventBatch(createTimelineState(), events)).toEqual(expected);
    expect(applyTimelineEventBatch(createTimelineState(), events).items[0]).toMatchObject({
      id: "answer-1",
      displayOrder: 1,
      text: "Hello world!",
    });
  });

  it("does not mutate the queued event array", () => {
    const events = [
      event({ id: "event-2", seq: 2, text: "First second" }),
      event({ id: "event-1", seq: 1, text: "First" }),
    ];
    const originalOrder = events.map((queuedEvent) => queuedEvent.id);

    applyTimelineEventBatch(createTimelineState(), events);

    expect(events.map((queuedEvent) => queuedEvent.id)).toEqual(originalOrder);
  });
});
