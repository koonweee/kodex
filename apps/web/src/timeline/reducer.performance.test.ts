import { describe, expect, it, vi } from "vitest";

import { applyTimelineEventBatch } from "./batch";
import { replayTimeline } from "./reducer";
import { applyTimelineEvent, event } from "./reducer.testUtils";

describe("timeline reducer performance", () => {
  it("updates and appends items in long active turns without array scan helpers", () => {
    const initialEvents = Array.from({ length: 150 }, (_, index) =>
      event({
        id: `initial-${index}`,
        seq: index + 1,
        itemId: `item-${index}`,
        payload: { item: { id: `item-${index}`, type: "agentMessage", text: `Message ${index}` } },
      }),
    );
    let state = replayTimeline(initialEvents);

    const findIndexSpy = vi.spyOn(Array.prototype, "findIndex").mockImplementation(() => {
      throw new Error("findIndex should not be used for timeline keyed updates");
    });
    const findSpy = vi.spyOn(Array.prototype, "find").mockImplementation(() => {
      throw new Error("find should not be used for timeline keyed updates");
    });
    const includesSpy = vi.spyOn(Array.prototype, "includes").mockImplementation(() => {
      throw new Error("includes should not be used for timeline keyed updates");
    });

    try {
      state = applyTimelineEvent(
        state,
        event({
          id: "delta-existing",
          seq: 151,
          codexMethod: "item/agentMessage/delta",
          itemId: "item-75",
          payload: { delta: " updated" },
        }),
      );
      state = applyTimelineEvent(
        state,
        event({
          id: "append-same-turn",
          seq: 152,
          itemId: "item-150",
          payload: { item: { id: "item-150", type: "agentMessage", text: "Message 150" } },
        }),
      );
    } finally {
      findIndexSpy.mockRestore();
      findSpy.mockRestore();
      includesSpy.mockRestore();
    }

    expect(state.items).toHaveLength(151);
    expect(state.items[75]).toMatchObject({ id: "item-75", text: "Message 75 updated" });
    expect(state.items[150]).toMatchObject({ id: "item-150", text: "Message 150" });
    expect(state.turns).toEqual([
      { turnId: "turn-1", itemIds: Array.from({ length: 151 }, (_, index) => `item-${index}`) },
    ]);
  });

  it("updates keyed items without materializing public timeline arrays in the reducer path", () => {
    let state = replayTimeline(
      Array.from({ length: 80 }, (_, index) =>
        event({
          id: `initial-${index}`,
          seq: index + 1,
          itemId: `item-${index}`,
          payload: { item: { id: `item-${index}`, type: "agentMessage", text: `Message ${index}` } },
        }),
      ),
    );

    for (const property of ["items", "hiddenItems", "turns"] as const) {
      Object.defineProperty(state, property, {
        configurable: true,
        get: () => {
          throw new Error(`${property} should not be materialized while applying a keyed update`);
        },
      });
    }

    state = applyTimelineEvent(
      state,
      event({
        id: "delta-existing",
        seq: 81,
        codexMethod: "item/agentMessage/delta",
        itemId: "item-40",
        payload: { delta: " updated" },
      }),
    );

    expect(state.items[40]).toMatchObject({ id: "item-40", text: "Message 40 updated" });
  });

  it("does not mutate previous timeline states when applying keyed updates", () => {
    const previous = replayTimeline([
      event({
        id: "initial-1",
        seq: 1,
        itemId: "item-1",
        payload: { item: { id: "item-1", type: "agentMessage", text: "Initial" } },
      }),
    ]);
    const previousItems = previous.items;
    const previousTurns = previous.turns;
    const previousHiddenItems = previous.hiddenItems;

    const next = applyTimelineEvent(
      previous,
      event({
        id: "delta-1",
        seq: 2,
        codexMethod: "item/agentMessage/delta",
        itemId: "item-1",
        payload: { delta: " updated" },
      }),
    );

    expect(previous.items).toBe(previousItems);
    expect(previous.turns).toBe(previousTurns);
    expect(previous.hiddenItems).toBe(previousHiddenItems);
    expect(previous.items[0]).toMatchObject({ id: "item-1", text: "Initial" });
    expect(previous.turns).toEqual([{ turnId: "turn-1", itemIds: ["item-1"] }]);
    expect(next.items[0]).toMatchObject({ id: "item-1", text: "Initial updated" });
  });

  it("produces stable batch results when invoked twice with the same current state", () => {
    const previous = replayTimeline([
      event({
        id: "initial-1",
        seq: 1,
        itemId: "item-1",
        payload: { item: { id: "item-1", type: "agentMessage", text: "Initial" } },
      }),
    ]);
    const queuedEvents = [
      event({
        id: "delta-1",
        seq: 2,
        codexMethod: "item/agentMessage/delta",
        itemId: "item-1",
        payload: { delta: " updated" },
      }),
      event({
        id: "append-1",
        seq: 3,
        itemId: "item-2",
        payload: { item: { id: "item-2", type: "agentMessage", text: "Second" } },
      }),
    ];

    const first = applyTimelineEventBatch(previous, queuedEvents);
    const second = applyTimelineEventBatch(previous, queuedEvents);

    expect(first).toEqual(second);
    expect(previous.items).toHaveLength(1);
    expect(previous.items[0].text).toBe("Initial");
    expect(first.items.map((item) => item.text)).toEqual(["Initial updated", "Second"]);
  });

});
