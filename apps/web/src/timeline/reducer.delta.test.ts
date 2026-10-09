import { describe, expect, it } from "vitest";

import type { EventEnvelope, ThreadViewResponse } from "../api/client";
import { applyLiveTimelineUpdate, applyTimelineHistoryWindow, applyTimelineSnapshot, canApplyThreadViewItemDelta } from "./reducer";
import { indexesForState, type TimelineRow, type TimelineState } from "./state";
import { timelineItem, timelineState } from "./testBuilders";

function delta(revision = 2, itemId = "native-answer"): EventEnvelope {
  return {
    id: `delta-${revision}`, seq: revision + 10, kind: "thread_view.item_delta",
    threadId: "thread-1", turnId: "turn-live", itemId,
    receivedAt: "2026-10-07T00:00:00Z",
    payload: { turnId: "turn-live", itemId, delta: " next", viewRevision: revision },
  };
}

function historyState(historySize: number): TimelineState {
  const items = Array.from({ length: historySize }, (_, index) => timelineItem({
    id: `history-${index}`, turnId: `turn-${index}`, displayOrder: index,
    text: `Historical answer ${index}`,
  }));
  items.push(timelineItem({
    id: "projection-answer", serverItemId: "native-answer", turnId: "turn-live",
    displayOrder: historySize, status: "running", text: "Seed",
  }));
  return timelineState({
    items, activeTurnId: "turn-live", viewRevision: 1, snapshotCoverageRevision: 1,
    turns: items.map((item) => ({
      turnId: item.turnId!, itemIds: [item.id], status: item.status,
      startedAtMs: item.displayOrder * 1000,
    })),
  });
}

describe("canonical text delta index updates", () => {
  it("preserves canonical turn metadata and earlier states while successive native-ID deltas update the answer", () => {
    const before = historyState(20);
    // Build the same cached indexes used by canonical snapshots.
    indexesForState(before);
    const first = applyLiveTimelineUpdate(before, delta());
    const second = applyLiveTimelineUpdate(first, delta(3));

    expect(before.items.at(-1)?.text).toBe("Seed");
    expect(first.items.at(-1)?.text).toBe("Seed next");
    expect(second.items.at(-1)?.text).toBe("Seed next next");
    expect(second.turns).toEqual(before.turns);
    expect(second.activeTurnId).toBe("turn-live");
    expect(second.viewRevision).toBe(3);
    expect(second.snapshotCoverageRevision).toBe(1);
    expect(second.lastSeq).toBe(13);
    expect(canApplyThreadViewItemDelta(first, delta(4))).toBe(true);
    expect(canApplyThreadViewItemDelta(before, delta(4))).toBe(true);
    for (let index = 0; index < 20; index += 1) {
      expect(second.rows[index]).toBe(before.rows[index]);
      expect(second.items[index]).toBe(before.items[index]);
    }
  });

  it("marks only the latest live append range without mutating earlier states", () => {
    const before = historyState(0);
    const first = applyLiveTimelineUpdate(before, delta());
    const second = applyLiveTimelineUpdate(first, delta(3));

    expect(before.items[0]).not.toHaveProperty("textDeltaStart");
    expect(first.items[0]).toMatchObject({ text: "Seed next", textDeltaStart: 4 });
    expect(second.items[0]).toMatchObject({ text: "Seed next next", textDeltaStart: 9 });
  });

  it.each(["snapshot", "reset_window", "full_snapshot", "row_delta"] as const)(
    "clears live append provenance when an append-like %s replaces canonical text", (replacement) => {
      const live = applyLiveTimelineUpdate(historyState(0), delta());
      const text = "Seed next restored";
      const snapshot = {
        thread: { id: "thread-1" },
        timeline: {
          viewRevision: 3, activeTurnId: "turn-live", liveState: "streaming",
          rows: [{
            id: "item-projection-answer", kind: "assistant_message", turnId: "turn-live",
            displayOrder: 0, status: "running",
            item: {
              id: "projection-answer", itemId: "native-answer", turnId: "turn-live",
              itemType: "agentMessage", status: "running", displayOrder: 0,
              payload: { item: { text } },
            },
          }],
        },
        historyPage: { resetWindow: true },
      } as ThreadViewResponse;
      const restored = replacement === "snapshot" ? applyTimelineSnapshot(live, snapshot)
        : replacement === "reset_window" ? applyTimelineHistoryWindow(live, snapshot)
        : applyLiveTimelineUpdate(live, {
          ...delta(3), kind: "thread_view.patch",
          payload: { ...snapshot.timeline, scope: replacement, affectedTurnIds: ["turn-live"] },
        });

      expect(live.items[0]).toMatchObject({ text: "Seed next", textDeltaStart: 4 });
      expect(restored.items).toHaveLength(1);
      expect(restored.items[0].text).toBe(text);
      expect(restored.items[0]).not.toHaveProperty("textDeltaStart");
      expect(applyLiveTimelineUpdate(restored, delta(4)).items[0]).toMatchObject({
        text: `${text} next`, textDeltaStart: text.length,
      });
    },
  );

  it.each(["activity", "work"] as const)("keeps %s targets and their item indexes synchronized", (type) => {
    const before = historyState(0);
    const answer = before.items[0];
    const other = timelineItem({ id: "other", turnId: "turn-live", kind: "command_execution", displayOrder: -1, text: "Tool" });
    const activity: TimelineRow = {
      type: "activity", key: "activity", turnKey: "turn-live", turnId: "turn-live",
      displayOrder: 0, items: [other, answer],
    };
    before.items = [other, answer];
    before.rows = type === "activity" ? [activity] : [{
      type: "work", key: "work", turnKey: "turn-live", turnId: "turn-live",
      state: "running", displayOrder: 0, collapsedRows: [activity],
    }];
    const first = applyLiveTimelineUpdate(before, delta());
    const second = applyLiveTimelineUpdate(first, delta(3, "projection-answer"));
    const row = second.rows[0];
    const nextActivity = row.type === "work" ? row.collapsedRows[0] : row;
    expect(nextActivity.type).toBe("activity");
    expect(nextActivity.type === "activity" ? nextActivity.items.map((item) => item.text) : []).toEqual(["Tool", "Seed next next"]);
    expect(second.items.map((item) => item.text)).toEqual(["Tool", "Seed next next"]);
    expect(before.items.map((item) => item.text)).toEqual(["Tool", "Seed"]);
    expect(canApplyThreadViewItemDelta(second, delta(4))).toBe(true);
  });

  it.runIf(process.env.KODEX_TIMELINE_DELTA_BENCH === "1")("records streaming delta costs at increasing history sizes", () => {
    for (const historySize of [100, 600, 1200]) {
      const samples: number[] = [];
      for (let sample = 0; sample < 5; sample += 1) {
        let state = historyState(historySize);
        indexesForState(state);
        const started = performance.now();
        for (let revision = 2; revision < 22; revision += 1) {
          state = applyLiveTimelineUpdate(state, delta(revision));
        }
        samples.push((performance.now() - started) / 20);
        expect(state.items.at(-1)?.text).toBe(`Seed${" next".repeat(20)}`);
      }
      samples.sort((left, right) => left - right);
      process.stdout.write(`TIMELINE_DELTA_BENCH history=${historySize} samples=5 deltas=20 medianMs=${samples[2].toFixed(3)}\n`);
    }
  });
});
