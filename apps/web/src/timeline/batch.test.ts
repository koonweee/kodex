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
    kind: "thread_view.patch",
    codexMethod: "thread_view/patch",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: null,
    projectId: "project-1",
    payload: {
      viewRevision: seq,
      threadId: "thread-1",
      activeTurnId: "turn-1",
      liveState: "streaming",
      rows: [canonicalRow(text)],
      turns: [],
      items: [canonicalItem(text)],
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

    const expected = [...events].sort((left, right) => left.seq - right.seq).reduce(applyLiveTimelineUpdate, createTimelineState());
    const actual = applyTimelineEventBatch(createTimelineState(), events);

    expect(actual.items[0]).toMatchObject({
      id: "projection-turn-1-answer-1",
      displayOrder: 1,
      text: expected.items[0].text,
    });
    expect(actual.viewRevision).toBe(expected.viewRevision);
    expect(actual.lastSeq).toBe(expected.lastSeq);
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

  it("applies same-frame projection patch bursts in sequence", () => {
    const events = [
      event({ id: "event-1", seq: 1, text: "H" }),
      event({ id: "event-2", seq: 2, text: "He" }),
      event({ id: "event-3", seq: 3, text: "Hello" }),
    ];

    const state = applyTimelineEventBatch(createTimelineState(), events);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      text: "Hello",
    });
    expect(state.items[0].debugEvents).toHaveLength(1);
  });

  it("keeps the latest same-frame canonical row state after sequential patches", () => {
    const state = applyTimelineEventBatch(createTimelineState(), [
      event({ id: "event-1", seq: 1, text: "Partial" }),
      event({ id: "event-2", seq: 2, text: "Canonical final" }),
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      text: "Canonical final",
      status: "running",
    });
    expect(state.items[0].debugEvents).toHaveLength(1);
    expect(state.items[0].debugEvents[0].kind).toBe("timeline.canonical_item");
  });

  it("drops stale patches when batching after a newer canonical view", () => {
    const canonical = applyLiveTimelineUpdate(createTimelineState(), event({ id: "event-10", seq: 10, text: "Canonical" }));

    const state = applyTimelineEventBatch(canonical, [
      event({ id: "event-5", seq: 5, text: "stale" }),
      event({ id: "event-11", seq: 11, text: "fresh" }),
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      text: "fresh",
      status: "running",
    });
    expect(state.lastSeq).toBe(11);
  });
});

function canonicalItem(text: string) {
  return {
    id: "projection-turn-1-answer-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "answer-1",
    itemType: "agentMessage",
    displayOrder: 1,
    status: "running",
    timestampMs: 1,
    codexMethod: "item/upsert",
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
  };
}

function canonicalRow(text: string) {
  const item = canonicalItem(text);
  return {
    id: `item-${item.id}`,
    kind: "assistant_message",
    turnId: item.turnId,
    displayOrder: item.displayOrder,
    status: item.status,
    timestampMs: item.timestampMs,
    item,
    items: [],
    fileChanges: [],
    work: null,
    collapsedRows: [],
    dividerBefore: null,
  };
}
