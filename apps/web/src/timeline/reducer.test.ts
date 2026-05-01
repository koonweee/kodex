import { describe, expect, it, vi } from "vitest";

import { applyTimelineEventBatch } from "./batch";
import {
  addOptimisticUserMessage,
  applyTimelineEvent,
  createTimelineState,
  removeOptimisticUserMessage,
  replayTimeline,
  updateOptimisticUserMessage,
} from "./reducer";

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
  it("adds optimistic user messages and reconciles matching app-server events", () => {
    let state = createTimelineState();

    state = addOptimisticUserMessage(state, {
      clientRequestId: "client-message-1",
      images: [],
      text: "Ship it",
      turnId: null,
      confirmationState: "sending",
    });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "optimistic-client-message-1",
      kind: "user_message",
      source: "optimistic",
      clientRequestId: "client-message-1",
      confirmationState: "sending",
      text: "Ship it",
    });

    state = applyTimelineEvent(state, {
      id: "event-user",
      seq: 1,
      kind: "codex.notification",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-1",
      projectId: "project-1",
      payload: { item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Ship it" }] } },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "optimistic-client-message-1",
      serverItemId: "user-1",
      kind: "user_message",
      source: "app_server",
      confirmationState: "sent",
      text: "Ship it",
      turnId: "turn-1",
    });
  });

  it("does not duplicate a replayed app-server user message after optimistic confirmation", () => {
    let state = createTimelineState();
    const confirmedUserMessage = {
      id: "event-user",
      seq: 1,
      kind: "codex.notification",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-1",
      projectId: "project-1",
      payload: { item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Ship it" }] } },
      receivedAt: "2026-04-30T00:00:00Z",
    } satisfies Parameters<typeof applyTimelineEvent>[1];

    state = addOptimisticUserMessage(state, {
      clientRequestId: "client-message-1",
      images: [],
      text: "Ship it",
      turnId: null,
      confirmationState: "sending",
    });
    state = applyTimelineEvent(state, confirmedUserMessage);
    state = applyTimelineEvent(state, { ...confirmedUserMessage, id: "event-user-replay", seq: 2 });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "optimistic-client-message-1",
      serverItemId: "user-1",
      source: "app_server",
      text: "Ship it",
    });
  });

  it("updates optimistic user message status", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Ship it",
      turnId: null,
      confirmationState: "sending",
    });

    state = updateOptimisticUserMessage(state, "client-message-1", {
      confirmationState: "failed",
      error: "Gateway request failed",
    });

    expect(state.items[0]).toMatchObject({
      confirmationState: "failed",
      error: "Gateway request failed",
    });
  });

  it("removes optimistic user messages from turn grouping", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Steer this",
      turnId: "turn-1",
      confirmationState: "sending",
    });

    expect(state.items).toHaveLength(1);
    expect(state.turns).toEqual([{ turnId: "turn-1", itemIds: ["optimistic-client-message-1"] }]);

    state = removeOptimisticUserMessage(state, "client-message-1");

    expect(state.items).toHaveLength(0);
    expect(state.turns).toHaveLength(0);
  });

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
    ]);

    expect(state.items.map((item) => item.kind)).toEqual([
      "user_message",
      "reasoning_summary",
      "web_search_group",
      "command_execution",
      "file_change",
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

  it("reduces schema-valid fileChange changes arrays into visible file activity", () => {
    const state = replayTimeline([
      event({
        id: "file-schema",
        seq: 1,
        itemId: "file-schema",
        payload: {
          item: {
            id: "file-schema",
            type: "fileChange",
            status: "completed",
            changes: [
              {
                path: "src/App.tsx",
                kind: { type: "update" },
                diff: "@@ -1 +1 @@\n-old\n+new",
              },
              {
                path: "src/new.ts",
                kind: { type: "add" },
                diff: "+export const value = 1;",
              },
            ],
          },
        },
      }),
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "file_change",
      action: "update, add",
      path: "src/App.tsx, src/new.ts",
      output: "@@ -1 +1 @@\n-old\n+new\n+export const value = 1;",
      text: "update, add src/App.tsx, src/new.ts",
    });
    expect(state.hiddenItems).toHaveLength(0);
  });

  it("reduces schema-valid query-only webSearch items into search activity", () => {
    const state = replayTimeline([
      event({
        id: "web-query-only",
        seq: 1,
        itemId: "web-query-only",
        payload: {
          item: {
            id: "web-query-only",
            type: "webSearch",
            query: "Codex app server schema",
            action: null,
          },
        },
      }),
    ]);

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "web_search_group",
      actions: [{ kind: "search", query: "Codex app server schema" }],
      text: 'Searched web for "Codex app server schema"',
    });
    expect(state.hiddenItems).toHaveLength(0);
  });

  it("hides unknown and hook prompt app-server items while retaining debug payloads", () => {
    const state = replayTimeline([
      event({
        id: "unknown-1",
        seq: 1,
        itemId: "future-1",
        payload: { item: { id: "future-1", type: "futureThing", value: true } },
      }),
      event({
        id: "hook-1",
        seq: 2,
        itemId: "hook-1",
        payload: { item: { id: "hook-1", type: "hookPrompt", fragments: [{ text: "Retry", hookRunId: "hook-run-1" }] } },
      }),
      event({
        id: "warning-1",
        seq: 3,
        kind: "codex.warning",
        codexMethod: "turn/warning",
        itemId: null,
        payload: { message: "Rate limit approaching" },
      }),
    ]);

    expect(state.items.map((item) => item.kind)).toEqual(["warning"]);
    expect(state.hiddenItems.map((item) => item.text)).toEqual(["Unsupported item", "Hook prompt"]);
  });

  it("reduces collaboration app-server tool calls into activity items", () => {
    const state = replayTimeline([
      event({
        id: "collab-start",
        seq: 1,
        itemId: "collab-1",
        payload: {
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "inProgress",
            receiverThreadIds: ["thread-reviewer"],
            agentsStates: {},
          },
        },
      }),
      event({
        id: "collab-complete",
        seq: 2,
        codexMethod: "item/completed",
        itemId: "collab-1",
        payload: {
          item: {
            id: "collab-1",
            type: "collabAgentToolCall",
            tool: "wait",
            status: "completed",
            receiverThreadIds: ["thread-reviewer"],
            agentsStates: {
              "thread-reviewer": { status: "completed", message: "No major issues remain." },
            },
          },
        },
      }),
      event({
        id: "collab-failed",
        seq: 3,
        itemId: "collab-2",
        payload: {
          item: {
            id: "collab-2",
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "failed",
            receiverThreadIds: ["thread-failed"],
            agentsStates: {},
          },
        },
      }),
    ]);

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({
      id: "collab-1",
      kind: "collab_agent_tool_call",
      status: "completed",
      text: "Finished waiting",
      toolName: "wait",
      resultSummary: expect.stringContaining("No major issues remain."),
    });
    expect(state.items[0].debugEvents).toHaveLength(2);
    expect(state.items[1]).toMatchObject({
      id: "collab-2",
      kind: "collab_agent_tool_call",
      status: "failed",
      text: "Agent spawn failed",
    });
  });

  it("reduces plan, review, compaction, and image app-server items into stable timeline kinds", () => {
    const state = replayTimeline([
      event({
        id: "plan-1",
        seq: 1,
        itemId: "plan-1",
        payload: { item: { id: "plan-1", type: "plan", text: "1. Inspect\n2. Patch" } },
      }),
      event({
        id: "review-start",
        seq: 2,
        itemId: "review-start",
        payload: { item: { id: "review-start", type: "enteredReviewMode", review: "Review image support" } },
      }),
      event({
        id: "review-end",
        seq: 3,
        itemId: "review-end",
        payload: { item: { id: "review-end", type: "exitedReviewMode", review: "Review image support" } },
      }),
      event({
        id: "compact-1",
        seq: 4,
        itemId: "compact-1",
        payload: { item: { id: "compact-1", type: "contextCompaction" } },
      }),
      event({
        id: "image-view-1",
        seq: 5,
        itemId: "image-view-1",
        payload: { item: { id: "image-view-1", type: "imageView", path: "/tmp/input.png" } },
      }),
      event({
        id: "image-generation-1",
        seq: 6,
        itemId: "image-generation-1",
        payload: {
          item: {
            id: "image-generation-1",
            type: "imageGeneration",
            status: "completed",
            result: "completed",
            revisedPrompt: "A diagram",
            savedPath: "/tmp/generated.png",
          },
        },
      }),
    ]);

    expect(state.items.map((item) => item.kind)).toEqual([
      "plan",
      "review_mode_started",
      "review_mode_finished",
      "context_compaction",
      "image_view",
      "image_generation",
    ]);
    expect(state.items.map((item) => item.text)).toEqual([
      "1. Inspect\n2. Patch",
      "Code review started: Review image support",
      "Code review finished",
      "Context compacted",
      "Viewed image",
      "Generated image",
    ]);
    expect(state.items.find((item) => item.kind === "image_view")).toMatchObject({ path: "/tmp/input.png" });
    expect(state.items.find((item) => item.kind === "image_generation")).toMatchObject({
      path: "/tmp/generated.png",
      resultSummary: "A diagram",
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

  it("does not revive completed turns from hidden thread metadata events", () => {
    const state = replayTimeline([
      event({
        id: "turn-start",
        seq: 1,
        codexMethod: "turn/started",
        itemId: null,
      }),
      event({
        id: "turn-completed",
        seq: 2,
        codexMethod: "turn/completed",
        itemId: null,
      }),
      event({
        id: "token-usage",
        seq: 3,
        codexMethod: "thread/tokenUsage/updated",
        itemId: null,
      }),
    ]);

    expect(state.activeTurnId).toBeNull();
    expect(state.items).toEqual([]);
    expect(state.hiddenItems.map((item) => item.id)).toEqual(["debug-turn-start", "debug-turn-completed", "debug-token-usage"]);
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
