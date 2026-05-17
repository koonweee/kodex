import { describe, expect, it } from "vitest";

import { applyLiveTimelineUpdate, createTimelineState, replayTimeline } from "./reducer";
import type { EventEnvelope } from "../api/client";

describe("timeline reducer lifecycle", () => {
  it("ignores non-canonical timeline events for visible rows while advancing the cursor", () => {
    const state = applyLiveTimelineUpdate(createTimelineState(), event({
      seq: 5,
      kind: ["timeline", "item_delta"].join("."),
      codexMethod: "item/agentMessage/delta",
      payload: { delta: "ignored" },
    }));

    expect(state.items).toEqual([]);
    expect(state.activeTurnId).toBeNull();
    expect(state.lastSeq).toBe(5);
  });

  it("keeps snapshot-required as a cursor-only render event", () => {
    const state = applyLiveTimelineUpdate(createTimelineState(), event({
      seq: 7,
      kind: "timeline.snapshot_required",
      codexMethod: "thread/snapshot_required",
      payload: { reason: "lagged" },
    }));

    expect(state.items).toEqual([]);
    expect(state.hiddenItems).toEqual([]);
    expect(state.lastSeq).toBe(7);
  });

  it("renders gateway warning and error events as diagnostics", () => {
    let state = createTimelineState();
    state = applyLiveTimelineUpdate(state, event({
      seq: 1,
      kind: "gateway.warning",
      itemId: null,
      payload: { message: "warning text" },
    }));
    state = applyLiveTimelineUpdate(state, event({
      seq: 2,
      kind: "gateway.error",
      itemId: null,
      payload: { message: "error text" },
    }));

    expect(state.items.map((item) => item.kind)).toEqual(["warning", "error"]);
    expect(state.items.map((item) => item.text)).toEqual(["warning text", "error text"]);
    expect(state.lastSeq).toBe(2);
  });

  it("replays canonical and cursor-only events in sequence", () => {
    const state = replayTimeline([
      event({ seq: 1, kind: "timeline.snapshot_required" }),
      event({
        seq: 2,
        kind: "timeline.projection_patch",
        codexMethod: "timeline/projection_patch",
        payload: projectionPatch("Hello"),
      }),
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "projection-turn-1-item-1",
      kind: "assistant_message",
      text: "Hello",
    });
    expect(state.viewRevision).toBe(2);
  });
});

function event(overrides: Partial<EventEnvelope>): EventEnvelope {
  return {
    id: `event-${overrides.seq ?? 1}`,
    seq: overrides.seq ?? 1,
    kind: overrides.kind ?? "codex.notification",
    codexMethod: overrides.codexMethod ?? null,
    threadId: overrides.threadId ?? "thread-1",
    turnId: overrides.turnId ?? "turn-1",
    itemId: Object.hasOwn(overrides, "itemId") ? (overrides.itemId ?? null) : "item-1",
    projectId: overrides.projectId ?? null,
    payload: overrides.payload ?? {},
    receivedAt: overrides.receivedAt ?? "2026-05-17T00:00:00Z",
  };
}

function projectionPatch(text: string) {
  return {
    threadId: "thread-1",
    revision: 2,
    activeTurnId: null,
    liveState: "idle",
    pendingApprovalRequests: [],
    pendingUserInputRequests: [],
    items: [
      {
        id: "projection-turn-1-item-1",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        itemType: "agentMessage",
        status: "completed",
        displayOrder: 1,
        codexMethod: "item/completed",
        timestampMs: 1_779_000_000_000,
        payload: {
          source: "gatewayStream",
          turnId: "turn-1",
          itemId: "item-1",
          item: { id: "item-1", type: "agentMessage", phase: "final_answer", text },
          itemSnapshot: {
            id: "item-1",
            itemType: "agentMessage",
            text,
            rawPayload: { id: "item-1", type: "agentMessage", phase: "final_answer", text },
            skillMentions: [],
          },
        },
      },
    ],
  };
}
