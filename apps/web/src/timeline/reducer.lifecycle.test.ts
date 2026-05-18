import { describe, expect, it } from "vitest";

import { applyLiveTimelineUpdate, createTimelineState, replayTimeline } from "./reducer";
import type { EventEnvelope } from "../api/client";

describe("timeline reducer lifecycle", () => {
  it("ignores raw compact live assistant deltas as render inputs", () => {
    let state = applyLiveTimelineUpdate(createTimelineState(), event({
      seq: 5,
      kind: "timeline.item_delta",
      codexMethod: "item/agentMessage/delta",
      payload: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "Hello" },
    }));
    state = applyLiveTimelineUpdate(state, event({
      seq: 6,
      kind: "timeline.item_delta",
      codexMethod: "item/agentMessage/delta",
      payload: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: " world" },
    }));

    expect(state.items).toEqual([]);
    expect(state.activeTurnId).toBeNull();
    expect(state.lastSeq).toBe(6);
  });

  it("applies canonical thread view item deltas as compact live transcript updates", () => {
    let state = applyLiveTimelineUpdate(createTimelineState(), event({
      seq: 10,
      kind: "thread_view.item_delta",
      codexMethod: "thread_view/item_delta",
      payload: threadViewItemDelta("Hello"),
    }));
    state = applyLiveTimelineUpdate(state, event({
      seq: 11,
      kind: "thread_view.item_delta",
      codexMethod: "thread_view/item_delta",
      payload: threadViewItemDelta(" world"),
    }));

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "projection-turn-1-item-1",
      serverItemId: "item-1",
      kind: "assistant_message",
      text: "Hello world",
      status: "running",
    });
    expect(state.activeTurnId).toBe("turn-1");
    expect(state.lastSeq).toBe(11);
    expect(state.viewRevision).toBe(11);
  });

  it("applies canonical thread view patches as structural transcript updates", () => {
    let state = applyLiveTimelineUpdate(createTimelineState(), event({
      seq: 10,
      kind: "thread_view.patch",
      codexMethod: "thread_view/patch",
      payload: projectionPatch("Final"),
    }));
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      text: "Final",
      status: "completed",
    });
    expect(state.lastSeq).toBe(10);
  });

  it("lets canonical thread view patches replace older canonical text", () => {
    let state = applyLiveTimelineUpdate(createTimelineState(), event({
      seq: 3,
      kind: "thread_view.patch",
      codexMethod: "thread_view/patch",
      payload: projectionPatchWithLiveState({
        viewRevision: 3,
        activeTurnId: "turn-1",
        liveState: "streaming",
        status: "running",
        text: "Live partial",
      }),
    }));
    state = applyLiveTimelineUpdate(state, event({
      seq: 8,
      kind: "thread_view.patch",
      codexMethod: "thread_view/patch",
      payload: projectionPatchWithLiveState({
        viewRevision: 8,
        activeTurnId: null,
        liveState: "idle",
        status: "completed",
        text: "Canonical final",
      }),
    }));

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "projection-turn-1-item-1",
      text: "Canonical final",
      status: "completed",
    });
    expect(state.viewRevision).toBe(8);
  });

  it("clears an active turn from a duplicate terminal projection patch", () => {
    let state = applyLiveTimelineUpdate(createTimelineState(), event({
      seq: 10,
      kind: "thread_view.patch",
      codexMethod: "thread_view/patch",
      payload: projectionPatchWithLiveState({
        viewRevision: 10,
        activeTurnId: "turn-1",
        liveState: "streaming",
        status: "running",
        text: "Still working",
      }),
    }));

    state = applyLiveTimelineUpdate(state, event({
      seq: 11,
      kind: "thread_view.patch",
      codexMethod: "thread_view/patch",
      payload: projectionPatchWithLiveState({
        viewRevision: 10,
        activeTurnId: null,
        liveState: "idle",
        status: "completed",
        text: "Done",
      }),
    }));

    expect(state.activeTurnId).toBeNull();
    expect(state.lastSeq).toBe(11);
    expect(state.viewRevision).toBe(11);
  });

  it("does not let an older terminal patch clear a newer active turn", () => {
    let state = applyLiveTimelineUpdate(createTimelineState(), event({
      seq: 10,
      kind: "thread_view.patch",
      codexMethod: "thread_view/patch",
      payload: projectionPatchWithLiveState({
        viewRevision: 10,
        activeTurnId: "turn-2",
        liveState: "streaming",
        status: "running",
        text: "Newer work",
      }),
    }));

    state = applyLiveTimelineUpdate(state, event({
      seq: 9,
      kind: "thread_view.patch",
      codexMethod: "thread_view/patch",
      turnId: "turn-1",
      payload: projectionPatchWithLiveState({
        viewRevision: 9,
        activeTurnId: null,
        liveState: "idle",
        status: "completed",
        text: "Older done",
        turnId: "turn-1",
      }),
    }));

    expect(state.activeTurnId).toBe("turn-2");
    expect(state.lastSeq).toBe(10);
    expect(state.viewRevision).toBe(10);
  });

  it("ignores an older terminal patch after a newer active turn patch", () => {
    let state = applyLiveTimelineUpdate(createTimelineState(), event({
      seq: 12,
      kind: "thread_view.patch",
      codexMethod: "thread_view/patch",
      turnId: "turn-2",
      itemId: "item-2",
      payload: projectionPatchWithLiveState({
        viewRevision: 12,
        activeTurnId: "turn-2",
        liveState: "streaming",
        status: "running",
        text: "New turn work",
        turnId: "turn-2",
      }),
    }));

    state = applyLiveTimelineUpdate(state, event({
      seq: 10,
      kind: "thread_view.patch",
      codexMethod: "thread_view/patch",
      turnId: "turn-1",
      payload: projectionPatchWithLiveState({
        viewRevision: 10,
        activeTurnId: null,
        liveState: "idle",
        status: "completed",
        text: "Older turn done",
        turnId: "turn-1",
      }),
    }));

    expect(state.activeTurnId).toBe("turn-2");
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      text: "New turn work",
      status: "running",
      turnId: "turn-2",
    });
    expect(state.lastSeq).toBe(12);
    expect(state.viewRevision).toBe(12);
  });

  it("keeps thread view refresh-required as a cursor-only render event", () => {
    const state = applyLiveTimelineUpdate(createTimelineState(), event({
      seq: 7,
      kind: "thread_view.refresh_required",
      codexMethod: "thread_view/refresh_required",
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
      event({ seq: 1, kind: "thread_view.refresh_required" }),
      event({
        seq: 2,
        kind: "thread_view.patch",
        codexMethod: "thread_view/patch",
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
    viewRevision: 2,
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

function threadViewItemDelta(delta: string) {
  return {
    viewRevision: 1,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    delta,
    phase: "final_answer",
    itemType: "agentMessage",
    liveState: "streaming",
  };
}

function projectionPatchWithLiveState({
  activeTurnId,
  liveState,
  viewRevision,
  status,
  text,
  turnId = "turn-1",
}: {
  activeTurnId: string | null;
  liveState: "streaming" | "idle";
  viewRevision: number;
  status: string;
  text: string;
  turnId?: string;
}) {
  const patch = projectionPatch(text);
  return {
    ...patch,
    activeTurnId,
    liveState,
    viewRevision,
    items: patch.items.map((item) => ({
      ...item,
      id: `projection-${turnId}-item-1`,
      turnId,
      status,
      codexMethod: status === "completed" ? "item/completed" : "item/upsert",
      payload: {
        ...item.payload,
        turnId,
        item: { id: "item-1", type: "agentMessage", text },
        itemSnapshot: {
          id: "item-1",
          itemType: "agentMessage",
          text,
          rawPayload: { id: "item-1", type: "agentMessage", phase: "final_answer", text },
          skillMentions: [],
        },
      },
    })),
    turns: [{ id: turnId, status }],
  };
}
