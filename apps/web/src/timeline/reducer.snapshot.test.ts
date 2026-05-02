import { describe, expect, it } from "vitest";

import type { ThreadDetailResponse } from "../api/client";
import { addOptimisticUserMessage, applyTimelineEvent, applyTimelineSnapshot, createTimelineState } from "./reducer";

describe("timeline reducer snapshots", () => {
  it("loads app-server snapshot turns and replaces stale canonical rows", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("First answer", "agent-1"));

    expect(state.items.map((item) => item.text)).toEqual(["Hello", "First answer"]);
    expect(state.turns).toEqual([{ turnId: "turn-1", itemIds: ["user-1", "agent-1"] }]);

    state = applyTimelineSnapshot(state, snapshot("Updated answer", "agent-2"));

    expect(state.items.map((item) => item.text)).toEqual(["Hello", "Updated answer"]);
    expect(state.items.map((item) => item.id)).toEqual(["user-1", "agent-2"]);
  });

  it("reconciles optimistic user messages when the snapshot includes the server item", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Hello",
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineSnapshot(state, snapshot("Agent response", "agent-1"));

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({
      id: "optimistic-client-message-1",
      serverItemId: "user-1",
      source: "app_server",
      confirmationState: "sent",
      text: "Hello",
      turnId: "turn-1",
    });
  });

  it("applies normalized snapshot upserts and gateway deltas on the same item path", () => {
    let state = createTimelineState();
    state = applyTimelineEvent(state, {
      id: "turn-upsert-1",
      seq: 0,
      kind: "timeline.turn_upsert",
      codexMethod: "turn/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: null,
      projectId: null,
      payload: {
        source: "appServerSnapshot",
        liveState: "syncing",
        turn: { id: "turn-1", status: "running", items: [] },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    state = applyTimelineEvent(state, {
      id: "item-upsert-1",
      seq: 0,
      kind: "timeline.item_upsert",
      codexMethod: "item/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      projectId: null,
      payload: {
        source: "appServerSnapshot",
        turnId: "turn-1",
        itemId: "agent-1",
        item: { id: "agent-1", type: "agentMessage", text: "Hel" },
        itemSnapshot: { id: "agent-1", itemType: "agentMessage", rawPayload: {} },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    state = applyTimelineEvent(state, {
      id: "item-delta-1",
      seq: 1,
      kind: "timeline.item_delta",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      projectId: null,
      payload: { source: "gatewayStream", delta: "lo", rawPayload: { delta: "lo" } },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(state.activeTurnId).toBe("turn-1");
    expect(state.items.map((item) => item.text)).toEqual(["Hello"]);
    expect(state.turns).toEqual([{ turnId: "turn-1", itemIds: ["agent-1"] }]);
  });

  it("does not mark completed snapshot turns active when thread syncs", () => {
    let state = createTimelineState();
    state = applyTimelineEvent(state, {
      id: "turn-upsert-1",
      seq: 0,
      kind: "timeline.turn_upsert",
      codexMethod: "turn/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: null,
      projectId: null,
      payload: {
        source: "appServerSnapshot",
        liveState: "syncing",
        turn: { id: "turn-1", status: "completed", items: [] },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(state.activeTurnId).toBeNull();

    state = applyTimelineSnapshot(state, {
      ...snapshot("Done", "agent-1"),
      liveState: "syncing",
    });

    expect(state.activeTurnId).toBeNull();
  });

  it("does not mark historical item upserts active without a live turn", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Done", "agent-1"));

    expect(state.activeTurnId).toBeNull();

    state = applyTimelineEvent(state, {
      id: "historical-item-upsert-1",
      seq: 2,
      kind: "timeline.item_upsert",
      codexMethod: "item/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      projectId: null,
      payload: {
        source: "appServerSnapshot",
        turnId: "turn-1",
        itemId: "agent-1",
        item: { id: "agent-1", type: "agentMessage", text: "Done" },
        itemSnapshot: { id: "agent-1", itemType: "agentMessage", rawPayload: {} },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(state.activeTurnId).toBeNull();
  });

  it("deduplicates replayed completed app-server items after a snapshot", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Done", "agent-1"));

    state = applyTimelineEvent(state, {
      id: "historical-user-upsert-1",
      seq: 2,
      kind: "timeline.item_upsert",
      codexMethod: "item/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-replay-1",
      projectId: null,
      payload: {
        source: "appServerSnapshot",
        turnId: "turn-1",
        itemId: "user-replay-1",
        item: { id: "user-replay-1", type: "userMessage", content: [{ type: "text", text: "Hello" }] },
        itemSnapshot: { id: "user-replay-1", itemType: "userMessage", rawPayload: {} },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    state = applyTimelineEvent(state, {
      id: "historical-agent-upsert-1",
      seq: 3,
      kind: "timeline.item_upsert",
      codexMethod: "item/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-replay-1",
      projectId: null,
      payload: {
        source: "appServerSnapshot",
        turnId: "turn-1",
        itemId: "agent-replay-1",
        item: { id: "agent-replay-1", type: "agentMessage", text: "Done" },
        itemSnapshot: { id: "agent-replay-1", itemType: "agentMessage", rawPayload: {} },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(state.items.map((item) => item.text)).toEqual(["Hello", "Done"]);
    expect(state.items.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(state.turns).toEqual([{ turnId: "turn-1", itemIds: ["user-1", "agent-1"] }]);
  });

  it("ignores repeated full-text deltas for completed snapshot items", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Done", "agent-1"));

    state = applyTimelineEvent(state, {
      id: "historical-agent-delta-1",
      seq: 2,
      kind: "timeline.item_delta",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      projectId: null,
      payload: { source: "gatewayStream", delta: "Done", rawPayload: { delta: "Done" } },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(state.items.map((item) => item.text)).toEqual(["Hello", "Done"]);
  });

  it("ignores replayed completed deltas that use a different item id than the snapshot", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Done", "agent-1"));

    state = applyTimelineEvent(state, {
      id: "historical-turn-upsert-1",
      seq: 2,
      kind: "timeline.turn_upsert",
      codexMethod: "turn/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: null,
      projectId: null,
      payload: {
        source: "gatewayStream",
        liveState: "streaming",
        turn: { id: "turn-1", status: "inProgress", items: [] },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    state = applyTimelineEvent(state, {
      id: "historical-agent-delta-1",
      seq: 3,
      kind: "timeline.item_delta",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-replay-1",
      projectId: null,
      payload: { source: "gatewayStream", type: "agentMessage", delta: "Do", rawPayload: { delta: "Do" } },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    state = applyTimelineEvent(state, {
      id: "historical-agent-delta-2",
      seq: 4,
      kind: "timeline.item_delta",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-replay-1",
      projectId: null,
      payload: { source: "gatewayStream", type: "agentMessage", delta: "ne", rawPayload: { delta: "ne" } },
      receivedAt: "2026-04-30T00:00:01Z",
    });

    expect(state.items.map((item) => item.text)).toEqual(["Hello", "Done"]);
    expect(state.items.map((item) => item.id)).toEqual(["user-1", "agent-1"]);
    expect(state.turns).toEqual([{ turnId: "turn-1", itemIds: ["user-1", "agent-1"] }]);
    expect(state.activeTurnId).toBeNull();
  });

  it("deduplicates a completed assistant upsert after streaming the same text under another item id", () => {
    let state = createTimelineState();

    state = applyTimelineEvent(state, {
      id: "agent-delta-1",
      seq: 1,
      kind: "timeline.item_delta",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-stream-1",
      projectId: null,
      payload: { source: "gatewayStream", type: "agentMessage", delta: "Done", rawPayload: { delta: "Done" } },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    state = applyTimelineEvent(state, {
      id: "agent-completed-1",
      seq: 2,
      kind: "timeline.item_upsert",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-completed-1",
      projectId: null,
      payload: {
        source: "gatewayStream",
        item: { id: "agent-completed-1", type: "agentMessage", text: "Done" },
      },
      receivedAt: "2026-04-30T00:00:01Z",
    });

    expect(state.items.map((item) => item.text)).toEqual(["Done"]);
    expect(state.items.map((item) => item.status)).toEqual(["completed"]);
    expect(state.turns).toEqual([{ turnId: "turn-1", itemIds: ["agent-stream-1"] }]);
  });

  it("keeps active-turn assistant deltas even when they match completed text in another item", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Done", "agent-1"));

    state = applyTimelineEvent(state, {
      id: "live-turn-upsert-1",
      seq: 2,
      kind: "timeline.turn_upsert",
      codexMethod: "turn/upsert",
      threadId: "thread-1",
      turnId: "turn-2",
      itemId: null,
      projectId: null,
      payload: {
        source: "gatewayStream",
        liveState: "streaming",
        turn: { id: "turn-2", status: "inProgress", items: [] },
      },
      receivedAt: "2026-04-30T00:00:01Z",
    });
    state = applyTimelineEvent(state, {
      id: "live-agent-delta-1",
      seq: 3,
      kind: "timeline.item_delta",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-2",
      itemId: "agent-live-1",
      projectId: null,
      payload: { source: "gatewayStream", type: "agentMessage", delta: "Do", rawPayload: { delta: "Do" } },
      receivedAt: "2026-04-30T00:00:02Z",
    });

    expect(state.activeTurnId).toBe("turn-2");
    expect(state.items.map((item) => item.text)).toEqual(["Hello", "Done", "Do"]);
    expect(state.turns).toEqual([
      { turnId: "turn-1", itemIds: ["user-1", "agent-1"] },
      { turnId: "turn-2", itemIds: ["agent-live-1"] },
    ]);
  });

  it("uses payload item ids to merge completed items when the event item id is absent", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Done", "agent-1"));

    state = applyTimelineEvent(state, {
      id: "agent-completed-event-1",
      seq: 2,
      kind: "timeline.item_upsert",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: null,
      projectId: null,
      payload: {
        source: "gatewayStream",
        item: { id: "agent-1", type: "agentMessage", text: "Done" },
      },
      receivedAt: "2026-04-30T00:00:01Z",
    });

    expect(state.items.map((item) => item.text)).toEqual(["Hello", "Done"]);
    expect(state.items.map((item) => item.id)).toEqual(["user-1", "agent-1"]);
  });
});

function snapshot(agentText: string, agentId: string): ThreadDetailResponse {
  return {
    thread: {
      id: "thread-1",
      name: "Snapshot thread",
      cwd: "/workspace",
      status: "idle",
      source: "local",
      preview: "Hello",
      createdAt: 1,
      updatedAt: 2,
      lastCompletedAgentTurnSeq: 1,
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: true,
      rawPayload: {},
    },
    liveState: "idle",
    rawPayload: {},
    turns: [
      {
        id: "turn-1",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        rawPayload: {},
        items: [
          {
            id: "user-1",
            itemType: "userMessage",
            rawPayload: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Hello" }] },
          },
          {
            id: agentId,
            itemType: "agentMessage",
            rawPayload: { id: agentId, type: "agentMessage", text: agentText },
          },
        ],
      },
    ],
  };
}
