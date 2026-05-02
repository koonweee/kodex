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
