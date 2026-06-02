import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import { applyTimelineEventBatch, coalesceTimelineEventBatch } from "./batch";
import {
  applyLiveTimelineUpdate,
  createTimelineState,
  getTimelineReducerInstrumentationForTest,
  resetTimelineReducerInstrumentationForTest,
} from "./reducer";

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
      scope: "turn",
      viewRevision: seq,
      threadId: "thread-1",
      activeTurnId: "turn-1",
      liveState: "streaming",
      affectedTurnIds: ["turn-1"],
      rows: [canonicalRow(text)],
      turns: [],
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

  it("coalesces same-frame projection patch bursts to the latest row state", () => {
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

  it("collapses large same-frame turn patch bursts before reducer application", () => {
    const events = Array.from({ length: 100 }, (_, index) =>
      event({ id: `event-${index + 1}`, seq: index + 1, text: `chunk-${index + 1}` }),
    );

    expect(coalesceTimelineEventBatch(events)).toHaveLength(1);
    const state = applyTimelineEventBatch(createTimelineState(), events);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: "chunk-100" });
    expect(state.items[0].debugEvents).toHaveLength(1);
    expect(state.lastSeq).toBe(100);
    expect(state.viewRevision).toBe(100);
  });

  it("coalesces same-frame canonical item deltas by concatenating chunks", () => {
    const events = [
      event({ id: "event-1", seq: 1, text: "H" }),
      itemDeltaEvent({ id: "event-2", seq: 2, delta: "e" }),
      itemDeltaEvent({ id: "event-3", seq: 3, delta: "llo" }),
    ];

    expect(coalesceTimelineEventBatch(events)).toHaveLength(2);
    const state = applyTimelineEventBatch(createTimelineState(), events);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: "Hello" });
    expect(state.lastSeq).toBe(3);
    expect(state.viewRevision).toBe(1);
  });

  it("does not coalesce item deltas across authoritative patches", () => {
    const events = [
      event({ id: "event-1", seq: 1, text: "A" }),
      itemDeltaEvent({ id: "event-2", seq: 2, delta: "B" }),
      event({ id: "event-3", seq: 3, text: "Canonical" }),
      itemDeltaEvent({ id: "event-4", seq: 4, delta: "D" }),
    ];
    const coalesced = coalesceTimelineEventBatch(events);

    expect(coalesced.filter((queuedEvent) => queuedEvent.kind === "thread_view.item_delta")).toHaveLength(2);
    const state = applyTimelineEventBatch(createTimelineState(), events);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: "CanonicalD" });
    expect(state.lastSeq).toBe(4);
    expect(state.viewRevision).toBe(3);
  });

  it("replaces the complete affected turn while preserving other large-thread rows", () => {
    const fullSnapshot = event({
      id: "event-full-snapshot",
      seq: 1,
      payload: {
        scope: "full_snapshot",
        viewRevision: 1,
        threadId: "thread-1",
        activeTurnId: "turn-1",
        liveState: "streaming",
        rows: Array.from({ length: 1000 }, (_, index) => canonicalRow(`row-${index + 1}`, index + 1)),
        turns: [],
      },
    });
    const initial = applyLiveTimelineUpdate(createTimelineState(), fullSnapshot);

    resetTimelineReducerInstrumentationForTest();
    const next = applyLiveTimelineUpdate(
      initial,
      event({
        id: "event-turn-patch",
        seq: 2,
        text: "updated row 1000",
        payload: {
          scope: "turn",
          viewRevision: 2,
          threadId: "thread-1",
          activeTurnId: "turn-1000",
          liveState: "streaming",
          affectedTurnIds: ["turn-1000"],
          rows: [canonicalRow("updated row 1000", 1000)],
          turns: [],
        },
      }),
    );

    expect(next.items).toHaveLength(1000);
    expect(next.items.at(-1)).toMatchObject({ text: "updated row 1000" });
    expect(getTimelineReducerInstrumentationForTest().turnPatchIndexedRows).toBe(1000);
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

  it("coalesces row-delta patches to latest row identity state", () => {
    const events = [
      event({ id: "event-1", seq: 1, text: "Initial" }),
      rowDeltaEvent({ id: "event-2", seq: 2, row: canonicalRow("Partial") }),
      rowDeltaEvent({ id: "event-3", seq: 3, row: canonicalRow("Latest") }),
    ];
    const coalesced = coalesceTimelineEventBatch(events);

    expect(coalesced).toHaveLength(2);
    expect(coalesced.at(-1)?.payload).toMatchObject({
      scope: "row_delta",
      viewRevision: 3,
      rows: [expect.objectContaining({ id: "item-projection-turn-1-answer-1" })],
    });

    const state = applyTimelineEventBatch(createTimelineState(), events);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ text: "Latest" });
    expect(state.lastSeq).toBe(3);
    expect(state.viewRevision).toBe(3);
  });

  it("does not merge row-delta removals and upserts across affected turns", () => {
    const initial = event({
      id: "event-1",
      seq: 1,
      payload: {
        scope: "full_snapshot",
        viewRevision: 1,
        threadId: "thread-1",
        activeTurnId: "turn-1",
        liveState: "streaming",
        rows: [canonicalRow("First", 1), canonicalRow("Second", 2)],
        turns: [],
      },
    });
    const events = [
      initial,
      rowDeltaEvent({ id: "event-2", seq: 2, row: canonicalRow("First updated", 1) }),
      rowDeltaEvent({
        id: "event-3",
        seq: 3,
        affectedTurnIds: ["turn-2"],
        removedRowIds: ["item-projection-turn-2-answer-2"],
      }),
    ];
    const sequential = events.reduce(applyLiveTimelineUpdate, createTimelineState());
    const batched = applyTimelineEventBatch(createTimelineState(), events);

    const coalescedPatches = coalesceTimelineEventBatch(events).filter((queuedEvent) => queuedEvent.kind === "thread_view.patch");
    expect(coalescedPatches).toHaveLength(3);
    expect(
      coalescedPatches.filter(
        (queuedEvent) =>
          (queuedEvent.payload as { scope?: unknown }).scope === "row_delta",
      ),
    ).toHaveLength(2);
    expect(batched.items.map((item) => item.text)).toEqual(sequential.items.map((item) => item.text));
    expect(batched.items.map((item) => item.id)).toEqual(["projection-turn-1-answer-1"]);
  });

  it("does not coalesce row-delta patches across item-delta or authoritative patch boundaries", () => {
    const events = [
      event({ id: "event-1", seq: 1, text: "A" }),
      rowDeltaEvent({ id: "event-2", seq: 2, row: canonicalRow("B") }),
      itemDeltaEvent({ id: "event-3", seq: 3, delta: "C" }),
      rowDeltaEvent({ id: "event-4", seq: 4, row: canonicalRow("D") }),
      {
        ...event({ id: "event-5", seq: 5, text: "refresh" }),
        kind: "thread_view.refresh_required",
        codexMethod: "thread_view/refresh_required",
        payload: { threadId: "thread-1", reason: "test" },
      } as EventEnvelope,
      rowDeltaEvent({ id: "event-6", seq: 6, row: canonicalRow("E") }),
      event({ id: "event-7", seq: 7, text: "Turn patch" }),
      rowDeltaEvent({ id: "event-8", seq: 8, row: canonicalRow("F") }),
      event({
        id: "event-9",
        seq: 9,
        payload: {
          scope: "full_snapshot",
          viewRevision: 9,
          threadId: "thread-1",
          activeTurnId: "turn-1",
          liveState: "streaming",
          rows: [canonicalRow("Snapshot")],
          turns: [],
        },
      }),
      rowDeltaEvent({ id: "event-10", seq: 10, row: canonicalRow("G") }),
    ];
    const coalesced = coalesceTimelineEventBatch(events);

    expect(coalesced.filter((queuedEvent) => queuedEvent.kind === "thread_view.item_delta")).toHaveLength(1);
    expect(
      coalesced.filter(
        (queuedEvent) =>
          queuedEvent.kind === "thread_view.patch" &&
          (queuedEvent.payload as { scope?: unknown }).scope === "row_delta",
      ),
    ).toHaveLength(5);
    expect(applyTimelineEventBatch(createTimelineState(), events).items[0]).toMatchObject({ text: "G" });
  });
});

function canonicalItem(text: string, index = 1) {
  return {
    id: `projection-turn-${index}-answer-${index}`,
    threadId: "thread-1",
    turnId: `turn-${index}`,
    itemId: `answer-${index}`,
    itemType: "agentMessage",
    displayOrder: index,
    status: "running",
    timestampMs: 1,
    codexMethod: "item/upsert",
    payload: {
      source: "gatewayStream",
      turnId: `turn-${index}`,
      itemId: `answer-${index}`,
      item: { id: `answer-${index}`, type: "agentMessage", text },
      itemSnapshot: {
        id: `answer-${index}`,
        itemType: "agentMessage",
        rawPayload: { id: `answer-${index}`, type: "agentMessage", text },
      },
    },
  };
}

function itemDeltaEvent(overrides: { id: string; seq: number; delta: string; itemId?: string; turnId?: string }): EventEnvelope {
  const turnId = overrides.turnId ?? "turn-1";
  const itemId = overrides.itemId ?? "answer-1";
  return {
    id: overrides.id,
    seq: overrides.seq,
    kind: "thread_view.item_delta",
    codexMethod: "thread_view/item_delta",
    threadId: "thread-1",
    turnId,
    itemId,
    projectId: "project-1",
    payload: {
      threadId: "thread-1",
      turnId,
      itemId,
      delta: overrides.delta,
      viewRevision: overrides.seq,
    },
    receivedAt: "2026-04-30T00:00:00Z",
  };
}

function rowDeltaEvent(overrides: {
  id: string;
  seq: number;
  row?: ReturnType<typeof canonicalRow>;
  affectedTurnIds?: string[];
  removedRowIds?: string[];
  threadId?: string;
}): EventEnvelope {
  const threadId = overrides.threadId ?? "thread-1";
  const rows = overrides.row ? [overrides.row] : [];
  return {
    id: overrides.id,
    seq: overrides.seq,
    kind: "thread_view.patch",
    codexMethod: "thread_view/patch",
    threadId,
    turnId: "turn-1",
    itemId: null,
    projectId: "project-1",
    payload: {
      scope: "row_delta",
      viewRevision: overrides.seq,
      threadId,
      activeTurnId: "turn-1",
      liveState: "streaming",
      affectedTurnIds: overrides.affectedTurnIds ?? [...new Set(rows.map((row) => row.turnId).filter(Boolean))],
      rows,
      removedRowIds: overrides.removedRowIds ?? [],
      turns: [],
    },
    receivedAt: "2026-04-30T00:00:00Z",
  };
}

function canonicalRow(text: string, index = 1) {
  const item = canonicalItem(text, index);
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
