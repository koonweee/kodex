import { describe, expect, it } from "vitest";

import { applyTimelineEvent, createTimelineState } from "./reducer";

describe("timeline reducer", () => {
  it("replays item lifecycle and turn completion events", () => {
    let state = createTimelineState();

    state = applyTimelineEvent(state, {
      id: "event-1",
      seq: 1,
      kind: "codex",
      codexMethod: "item/started",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      projectId: "project-1",
      payload: { type: "agent_message" },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    state = applyTimelineEvent(state, {
      id: "event-2",
      seq: 2,
      kind: "codex",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      projectId: "project-1",
      payload: { delta: "Hello" },
      receivedAt: "2026-04-30T00:00:01Z",
    });
    state = applyTimelineEvent(state, {
      id: "event-3",
      seq: 3,
      kind: "codex",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      projectId: "project-1",
      payload: { text: "Hello world" },
      receivedAt: "2026-04-30T00:00:02Z",
    });
    state = applyTimelineEvent(state, {
      id: "event-4",
      seq: 4,
      kind: "codex",
      codexMethod: "turn/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: null,
      projectId: "project-1",
      payload: {},
      receivedAt: "2026-04-30T00:00:03Z",
    });

    expect(state.lastSeq).toBe(4);
    expect(state.activeTurnId).toBeNull();
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "item-1",
      status: "completed",
      text: "Hello world",
    });
  });

  it("streams and completes final answer items from app-server payloads", () => {
    let state = createTimelineState();

    state = applyTimelineEvent(state, {
      id: "event-1",
      seq: 1,
      kind: "codex.notification",
      codexMethod: "item/started",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      projectId: "project-1",
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "answer-1", type: "agentMessage", phase: "final_answer", text: "" },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    state = applyTimelineEvent(state, {
      id: "event-2",
      seq: 2,
      kind: "codex.notification",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      projectId: "project-1",
      payload: { delta: "Live " },
      receivedAt: "2026-04-30T00:00:01Z",
    });
    state = applyTimelineEvent(state, {
      id: "event-3",
      seq: 3,
      kind: "codex.notification",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      projectId: "project-1",
      payload: { delta: "answer" },
      receivedAt: "2026-04-30T00:00:02Z",
    });
    state = applyTimelineEvent(state, {
      id: "event-4",
      seq: 4,
      kind: "codex.notification",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      projectId: "project-1",
      payload: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "answer-1", type: "agentMessage", phase: "final_answer", text: "Live answer." },
      },
      receivedAt: "2026-04-30T00:00:03Z",
    });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "answer-1",
      kind: "agent_message",
      status: "completed",
      text: "Live answer.",
    });
  });
});
