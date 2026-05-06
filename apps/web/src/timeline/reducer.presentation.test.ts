import { describe, expect, it } from "vitest";

import { replayTimeline } from "./reducer";
import { event } from "./reducer.testUtils";

describe("timeline reducer presentation", () => {
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
            result: "iVBORw0KGgo=",
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
      imageSrc: "data:image/png;base64,iVBORw0KGgo=",
      path: "/tmp/generated.png",
      resultSummary: "A diagram",
    });
  });

  it("normalizes raw image_generation_call response items into generated image timeline items", () => {
    const state = replayTimeline([
      event({
        id: "raw-image-generation-completed",
        seq: 1,
        codexMethod: "raw_response_item/completed",
        itemId: null,
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "raw-image-generation-1",
            type: "image_generation_call",
            status: "completed",
            result: "iVBORw0KGgo=",
            revised_prompt: "A schema-shaped diagram",
          },
        },
      }),
    ]);

    expect(state.hiddenItems).toHaveLength(0);
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "raw-image-generation-1",
      kind: "image_generation",
      status: "completed",
      text: "Generated image",
      imageSrc: "data:image/png;base64,iVBORw0KGgo=",
      resultSummary: "A schema-shaped diagram",
    });
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

});
