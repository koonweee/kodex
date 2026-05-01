import { describe, expect, it } from "vitest";

import { applyTimelineEvent, createTimelineState, replayTimeline } from "./reducer";

function event(overrides: Partial<Parameters<typeof applyTimelineEvent>[1]>): Parameters<typeof applyTimelineEvent>[1] {
  return {
    id: "event-1",
    seq: 1,
    kind: "codex.notification",
    codexMethod: "item/started",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    projectId: "project-1",
    payload: {},
    receivedAt: "2026-04-30T00:00:00Z",
    ...overrides,
  };
}

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
      kind: "assistant_message",
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

  it("reduces app-server events into user-facing timeline blocks and keeps raw payloads for debug", () => {
    const state = replayTimeline([
      event({
        id: "user-start",
        seq: 1,
        itemId: "user-1",
        payload: { item: { id: "user-1", type: "userMessage", text: "Search for current docs" } },
      }),
      event({
        id: "reasoning-empty",
        seq: 2,
        itemId: "reasoning-empty",
        payload: { item: { id: "reasoning-empty", type: "reasoning" } },
      }),
      event({
        id: "reasoning-summary",
        seq: 3,
        itemId: "reasoning-1",
        payload: { item: { id: "reasoning-1", type: "reasoning", summary: "Need current sources." } },
      }),
      event({
        id: "web-search-1",
        seq: 4,
        itemId: "web-1",
        payload: { item: { id: "web-1", type: "webSearch", action: { type: "search", query: "Codex app server" } } },
      }),
      event({
        id: "web-search-2",
        seq: 5,
        itemId: "web-2",
        payload: { item: { id: "web-2", type: "webSearch", action: { type: "open", url: "https://example.com", title: "Example" } } },
      }),
      event({
        id: "command-1",
        seq: 6,
        itemId: "cmd-1",
        payload: {
          item: {
            id: "cmd-1",
            type: "commandExecution",
            command: "cargo test",
            cwd: "/home/example/kodex",
            output: "ok",
          },
        },
      }),
      event({
        id: "file-1",
        seq: 7,
        itemId: "file-1",
        payload: { item: { id: "file-1", type: "fileChange", path: "src/App.tsx", action: "modify" } },
      }),
      event({
        id: "unknown-1",
        seq: 8,
        itemId: "future-1",
        payload: { item: { id: "future-1", type: "futureThing", value: true } },
      }),
    ]);

    expect(state.items.map((item) => item.kind)).toEqual([
      "user_message",
      "reasoning_summary",
      "web_search_group",
      "command_execution",
      "file_change",
      "debug_event",
    ]);
    expect(state.items.find((item) => item.kind === "web_search_group")).toMatchObject({
      id: "web-search-turn-1",
      actions: [
        { kind: "search", query: "Codex app server" },
        { kind: "open", title: "Example", url: "https://example.com" },
      ],
    });
    expect(state.items.find((item) => item.kind === "command_execution")).toMatchObject({
      command: "cargo test",
      cwd: "/home/example/kodex",
      output: "ok",
    });
    expect(state.items.find((item) => item.kind === "file_change")).toMatchObject({
      path: "src/App.tsx",
      action: "modify",
    });
    expect(state.hiddenItems).toHaveLength(1);
    expect(state.hiddenItems[0]).toMatchObject({ id: "debug-reasoning-empty", kind: "debug_event" });
    expect(state.items[0].debugEvents[0].payload).toEqual({
      item: { id: "user-1", type: "userMessage", text: "Search for current docs" },
    });
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

  it("groups presentation blocks by turn while preserving item order", () => {
    const state = replayTimeline([
      event({ id: "turn-1-user", seq: 1, itemId: "user-1", payload: { item: { type: "userMessage", text: "Hi" } } }),
      event({
        id: "turn-1-agent",
        seq: 2,
        itemId: "agent-1",
        payload: { item: { type: "agentMessage", text: "Hello" } },
      }),
      event({
        id: "turn-2-user",
        seq: 3,
        turnId: "turn-2",
        itemId: "user-2",
        payload: { item: { type: "userMessage", text: "Next" } },
      }),
    ]);

    expect(state.turns).toEqual([
      { turnId: "turn-1", itemIds: ["user-1", "agent-1"] },
      { turnId: "turn-2", itemIds: ["user-2"] },
    ]);
  });

  it("extracts message text from app-server content arrays", () => {
    const state = replayTimeline([
      event({
        id: "content-user",
        seq: 1,
        itemId: "user-1",
        payload: {
          item: {
            id: "user-1",
            type: "userMessage",
            content: [{ type: "text", text: "do a google search for current weather" }],
          },
        },
      }),
      event({
        id: "content-assistant",
        seq: 2,
        itemId: "agent-1",
        payload: {
          item: {
            id: "agent-1",
            type: "agentMessage",
            content: [{ type: "output_text", text: "What city or ZIP code should I check?" }],
          },
        },
      }),
    ]);

    expect(state.items).toMatchObject([
      { id: "user-1", kind: "user_message", text: "do a google search for current weather" },
      { id: "agent-1", kind: "assistant_message", text: "What city or ZIP code should I check?" },
    ]);
  });

  it("hides uninformative web search other and empty open-page actions by default", () => {
    const state = replayTimeline([
      event({
        id: "web-other",
        seq: 1,
        itemId: "web-other",
        payload: { item: { id: "web-other", type: "webSearch", action: { type: "other" } } },
      }),
      event({
        id: "web-empty-open",
        seq: 2,
        itemId: "web-empty-open",
        payload: { item: { id: "web-empty-open", type: "webSearch", action: { type: "openPage", url: null } } },
      }),
      event({
        id: "web-search",
        seq: 3,
        itemId: "web-search",
        payload: {
          item: {
            id: "web-search",
            type: "webSearch",
            action: { type: "search", query: "weather: San Francisco, CA" },
          },
        },
      }),
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "web_search_group",
      actions: [{ kind: "search", query: "weather: San Francisco, CA" }],
    });
    expect(state.hiddenItems.map((item) => item.id)).toEqual(["debug-web-other", "debug-web-empty-open"]);
  });
});
