import { describe, expect, it } from "vitest";

import { createTimelineState, replayTimeline } from "./reducer";
import { applyTimelineEvent, event } from "./reducer.testUtils";

describe("timeline reducer lifecycle", () => {
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
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "answer-1",
      kind: "assistant_message",
      messagePhase: "final_answer",
      status: "running",
      text: "Live ",
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
      kind: "assistant_message",
      messagePhase: "final_answer",
      status: "completed",
      text: "Live answer.",
    });
  });

  it("appends assistant message deltas while a response is streaming", () => {
    let state = createTimelineState();

    state = applyTimelineEvent(state, {
      id: "event-1",
      seq: 1,
      kind: "codex.notification",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      projectId: "project-1",
      payload: { delta: "For ZIP `941" },
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
      payload: { delta: "23` in San Francisco" },
      receivedAt: "2026-04-30T00:00:01Z",
    });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "answer-1",
      kind: "assistant_message",
      status: "running",
      text: "For ZIP `94123` in San Francisco",
    });
  });

  it("preserves leading whitespace in streamed assistant deltas", () => {
    let state = createTimelineState();

    state = applyTimelineEvent(state, {
      id: "event-1",
      seq: 1,
      kind: "codex.notification",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "answer-1",
      projectId: "project-1",
      payload: { delta: "I'll" },
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
      payload: { delta: " trace" },
      receivedAt: "2026-04-30T00:00:01Z",
    });

    expect(state.items[0].text).toBe("I'll trace");
  });

  it("filters empty messages and non-error lifecycle events while keeping warnings and errors visible", () => {
    const state = replayTimeline([
      event({
        id: "turn-start",
        seq: 1,
        codexMethod: "turn/started",
        itemId: null,
      }),
      event({
        id: "thread-status",
        seq: 2,
        codexMethod: "thread/status",
        itemId: null,
        payload: { status: "running" },
      }),
      event({
        id: "empty-user",
        seq: 3,
        itemId: "empty-user",
        payload: { item: { id: "empty-user", type: "userMessage", text: "" } },
      }),
      event({
        id: "warning-1",
        seq: 4,
        kind: "codex.warning",
        codexMethod: "turn/warning",
        itemId: null,
        payload: { message: "Rate limit approaching" },
      }),
      event({
        id: "error-1",
        seq: 5,
        kind: "codex.error",
        codexMethod: "turn/error",
        itemId: null,
        payload: { message: "Command failed" },
      }),
    ]);

    expect(state.items.map((item) => item.kind)).toEqual(["warning", "error"]);
    expect(state.items.map((item) => item.text)).toEqual(["Rate limit approaching", "Command failed"]);
    expect(state.hiddenItems.map((item) => item.id)).toEqual([
      "debug-turn-start",
      "debug-thread-status",
      "debug-empty-user",
    ]);
  });

  it("keeps active turn timing from normalized turn upserts", () => {
    let state = createTimelineState();
    state = applyTimelineEvent(state, {
      id: "turn-start",
      seq: 1,
      kind: "timeline.turn_upsert",
      codexMethod: "turn/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: null,
      projectId: "project-1",
      payload: {
        source: "gatewayStream",
        liveState: "streaming",
        turn: { id: "turn-1", status: "inProgress", startedAt: 1_767_225_600, items: [] },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(state.activeTurnId).toBe("turn-1");
    expect(state.turns).toEqual([
      {
        turnId: "turn-1",
        itemIds: [],
        status: "inProgress",
        startedAtMs: 1_767_225_600_000,
        completedAtMs: undefined,
      },
    ]);

    state = applyTimelineEvent(state, {
      id: "turn-complete",
      seq: 2,
      kind: "timeline.turn_upsert",
      codexMethod: "turn/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: null,
      projectId: "project-1",
      payload: {
        source: "gatewayStream",
        liveState: "idle",
        turn: {
          id: "turn-1",
          status: "completed",
          startedAt: 1_767_225_600,
          completedAt: 1_767_225_605,
          items: [],
        },
      },
      receivedAt: "2026-04-30T00:00:05Z",
    });

    expect(state.activeTurnId).toBeNull();
    expect(state.turns[0]).toMatchObject({
      turnId: "turn-1",
      status: "completed",
      startedAtMs: 1_767_225_600_000,
      completedAtMs: 1_767_225_605_000,
    });
  });

  it("preserves command metadata while streaming command output deltas", () => {
    let state = createTimelineState();

    state = applyTimelineEvent(state, {
      id: "command-start",
      seq: 1,
      kind: "codex.notification",
      codexMethod: "item/started",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      projectId: "project-1",
      payload: {
        item: {
          id: "cmd-1",
          type: "commandExecution",
          command: "cargo test",
          cwd: "/home/example/kodex",
          status: "inProgress",
        },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    state = applyTimelineEvent(state, {
      id: "command-output-1",
      seq: 2,
      kind: "codex.notification",
      codexMethod: "item/commandExecution/outputDelta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "cmd-1",
      projectId: "project-1",
      payload: { delta: "running 1 test\n" },
      receivedAt: "2026-04-30T00:00:01Z",
    });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "cmd-1",
      kind: "command_execution",
      command: "cargo test",
      cwd: "/home/example/kodex",
      output: "running 1 test\n",
    });
  });

});
