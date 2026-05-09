import { describe, expect, it } from "vitest";

import type { ThreadDetailResponse } from "../api/client";
import { sortedVisibleTimelineItems } from "./derive";
import {
  addOptimisticUserMessage,
  applyTimelineEvent,
  applyTimelineSnapshot,
  createTimelineState,
  updateOptimisticUserMessage,
} from "./reducer";

describe("timeline reducer snapshots", () => {
  it("loads app-server snapshot turns and replaces stale canonical rows", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("First answer", "agent-1"));

    expect(state.items.map((item) => item.text)).toEqual(["Hello", "First answer"]);
    expect(state.turns).toMatchObject([{ turnId: "turn-1", itemIds: ["user-1", "agent-1"] }]);

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
    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "optimistic-client-message-1",
      "agent-1",
    ]);
    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      serverItemId: "user-1",
      source: "app_server",
    });
  });

  it("loads skill mention metadata from snapshot item projections", () => {
    const state = applyTimelineSnapshot(createTimelineState(), snapshotWithSkillMention());

    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      kind: "user_message",
      text: "Use $agent-browser now",
      skillMentions: [
        {
          start: "Use ".length,
          end: "Use $agent-browser".length,
          name: "agent-browser",
          path: "/skills/agent-browser/SKILL.md",
        },
      ],
    });
  });

  it("replaces optimistic skill mentions with confirmed snapshot metadata", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Use $agent-browser now",
      skillMentions: [
        {
          start: "Use ".length,
          end: "Use $agent-browser".length,
          name: "agent-browser",
          path: "/stale/SKILL.md",
          displayName: "Stale Agent Browser",
          shortDescription: "Stale metadata",
        },
      ],
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineSnapshot(state, snapshotWithSkillMention());

    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      serverItemId: "user-skill",
      skillMentions: [
        {
          name: "agent-browser",
          path: "/skills/agent-browser/SKILL.md",
          displayName: "Agent Browser",
          shortDescription: "Browser automation",
        },
      ],
    });
  });

  it("preserves provisional skill mentions when confirmation has matching text but no normalized mentions", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Use $agent-browser now",
      skillMentions: [
        {
          start: "Use ".length,
          end: "Use $agent-browser".length,
          name: "agent-browser",
          path: "/skills/agent-browser/SKILL.md",
        },
      ],
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineSnapshot(state, snapshotWithUserOnlyTurn("Use $agent-browser now"));

    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      serverItemId: "user-1",
      source: "app_server",
      text: "Use $agent-browser now",
    });
    expect(sortedVisibleTimelineItems(state, false)[0]?.skillMentions).toEqual([
      {
        start: "Use ".length,
        end: "Use $agent-browser".length,
        name: "agent-browser",
        path: "/skills/agent-browser/SKILL.md",
      },
    ]);
  });

  it("applies live item upsert skill mention metadata", () => {
    const state = applyTimelineEvent(createTimelineState(), {
      id: "event-user-skill",
      seq: 1,
      kind: "timeline.item_upsert",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-skill",
      projectId: "project-1",
      payload: {
        item: {
          id: "user-skill",
          type: "userMessage",
          content: [{ type: "text", text: "Use $agent-browser now" }],
        },
        itemSnapshot: {
          id: "user-skill",
          itemType: "userMessage",
          rawPayload: {},
          skillMentions: [
            {
              start: "Use ".length,
              end: "Use $agent-browser".length,
              name: "agent-browser",
              path: "/skills/agent-browser/SKILL.md",
            },
          ],
        },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      id: "user-skill",
      skillMentions: [
        {
          name: "agent-browser",
          path: "/skills/agent-browser/SKILL.md",
        },
      ],
    });
  });

  it("reconciles optimistic skill mentions when a live confirmation has matching text but no normalized mentions", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Use $agent-browser now",
      skillMentions: [
        {
          start: "Use ".length,
          end: "Use $agent-browser".length,
          name: "agent-browser",
          path: "/skills/agent-browser/SKILL.md",
        },
      ],
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineEvent(state, {
      id: "event-user-skill-no-mentions",
      seq: 1,
      kind: "timeline.item_upsert",
      codexMethod: "item/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-skill",
      projectId: "project-1",
      payload: {
        item: {
          id: "user-skill",
          type: "userMessage",
          content: [{ type: "text", text: "Use $agent-browser now" }],
        },
        itemSnapshot: {
          id: "user-skill",
          itemType: "userMessage",
          rawPayload: {},
        },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(sortedVisibleTimelineItems(state, false)).toHaveLength(1);
    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      id: "optimistic-client-message-1",
      serverItemId: "user-skill",
      source: "app_server",
      text: "Use $agent-browser now",
    });
    expect(sortedVisibleTimelineItems(state, false)[0]?.skillMentions).toEqual([
      {
        start: "Use ".length,
        end: "Use $agent-browser".length,
        name: "agent-browser",
        path: "/skills/agent-browser/SKILL.md",
      },
    ]);
  });

  it("does not duplicate optimistic skill messages when app-server sidecars carry content", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Use $agent-browser now",
      skillMentions: [
        {
          start: "Use ".length,
          end: "Use $agent-browser".length,
          name: "agent-browser",
          path: "/skills/agent-browser/SKILL.md",
        },
      ],
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineEvent(state, {
      id: "event-user-skill-sidecar-content",
      seq: 1,
      kind: "timeline.item_upsert",
      codexMethod: "item/upsert",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-skill",
      projectId: "project-1",
      payload: {
        item: {
          id: "user-skill",
          type: "userMessage",
          content: [
            { type: "text", text: "Use $agent-browser now" },
            {
              type: "skill",
              name: "agent-browser",
              path: "/skills/agent-browser/SKILL.md",
              content: "Skill body should not be visible timeline text.",
            },
          ],
        },
        itemSnapshot: {
          id: "user-skill",
          itemType: "userMessage",
          rawPayload: {},
        },
      },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(sortedVisibleTimelineItems(state, false)).toHaveLength(1);
    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      id: "optimistic-client-message-1",
      serverItemId: "user-skill",
      source: "app_server",
      text: "Use $agent-browser now",
      skillMentions: [
        {
          name: "agent-browser",
          path: "/skills/agent-browser/SKILL.md",
        },
      ],
    });
  });

  it("carries failed optimistic skill mentions across snapshots", () => {
    const state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Use $agent-browser now",
      skillMentions: [
        {
          start: "Use ".length,
          end: "Use $agent-browser".length,
          name: "agent-browser",
          path: "/skills/agent-browser/SKILL.md",
        },
      ],
      turnId: null,
      confirmationState: "failed",
    });

    const refreshed = applyTimelineSnapshot(state, snapshot("Old answer", "agent-1"));

    expect(sortedVisibleTimelineItems(refreshed, false).at(-1)).toMatchObject({
      confirmationState: "failed",
      skillMentions: [
        {
          name: "agent-browser",
          path: "/skills/agent-browser/SKILL.md",
        },
      ],
    });
  });

  it("reconciles optimistic user messages when a running snapshot has only the user item", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Hello",
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineSnapshot(state, snapshotWithUserOnlyTurn("Hello"));

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "optimistic-client-message-1",
    ]);
    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      serverItemId: "user-1",
      source: "app_server",
      confirmationState: "sent",
      turnId: "turn-1",
    });
  });

  it("retains locally confirmed user messages across stale snapshots", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Hello",
      turnId: null,
      confirmationState: "sending",
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
      payload: { item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Hello" }] } },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(state.items[0]).toMatchObject({
      source: "app_server",
      clientRequestId: "client-message-1",
      confirmationState: "sent",
    });

    state = applyTimelineSnapshot(state, {
      ...snapshot("Agent response", "agent-1"),
      turns: [],
    });

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      kind: "user_message",
      clientRequestId: "client-message-1",
      confirmationState: "sent",
      text: "Hello",
      turnId: "turn-1",
    });
  });

  it("keeps locally optimistic user messages after stale snapshot rows", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Previous answer", "agent-1"));
    state = addOptimisticUserMessage(state, {
      clientRequestId: "client-message-1",
      images: [],
      text: "New question",
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineSnapshot(state, snapshot("Previous answer", "agent-1"));

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.text)).toEqual([
      "Hello",
      "Previous answer",
      "New question",
    ]);
  });

  it("keeps a duplicate optimistic user message when a stale snapshot has the same text", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Previous answer", "agent-1"));
    state = addOptimisticUserMessage(state, {
      clientRequestId: "client-message-1",
      images: [],
      text: "Hello",
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineSnapshot(state, snapshot("Previous answer", "agent-1"));

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.text)).toEqual([
      "Hello",
      "Previous answer",
      "Hello",
    ]);
    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "user-1",
      "agent-1",
      "optimistic-client-message-1",
    ]);
  });

  it("reconciles same-text local user messages when a response snapshot was not loaded first", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Hello",
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineSnapshot(state, snapshot("Previous answer", "agent-1"));

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.text)).toEqual([
      "Hello",
      "Previous answer",
    ]);
    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "optimistic-client-message-1",
      "agent-1",
    ]);
    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      serverItemId: "user-1",
      source: "app_server",
    });
  });

  it("reconciles same-text locally sent user messages when a response snapshot was not loaded first", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Hello",
      turnId: null,
      confirmationState: "sending",
    });
    state = updateOptimisticUserMessage(state, "client-message-1", { confirmationState: "sent" });

    state = applyTimelineSnapshot(state, snapshot("Previous answer", "agent-1"));

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.text)).toEqual([
      "Hello",
      "Previous answer",
    ]);
    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "optimistic-client-message-1",
      "agent-1",
    ]);
    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      serverItemId: "user-1",
      source: "app_server",
    });
  });

  it("reconciles the local user message when a refreshed snapshot includes a response", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Previous answer", "agent-1"));
    state = addOptimisticUserMessage(state, {
      clientRequestId: "client-message-1",
      images: [],
      text: "New question",
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineSnapshot(state, snapshotWithSecondUser("New question", "Next answer"));

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.text)).toEqual([
      "Hello",
      "Previous answer",
      "New question",
      "Next answer",
    ]);
    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "user-1",
      "agent-1",
      "optimistic-client-message-1",
      "agent-2",
    ]);
    expect(sortedVisibleTimelineItems(state, false)[2]).toMatchObject({
      serverItemId: "user-2",
      source: "app_server",
    });
  });

  it("keeps the reconciled local user message when a direct server event replays after a response snapshot", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Previous answer", "agent-1"));
    state = addOptimisticUserMessage(state, {
      clientRequestId: "client-message-1",
      images: [],
      text: "New question",
      turnId: null,
      confirmationState: "sending",
    });
    state = applyTimelineSnapshot(state, snapshotWithSecondUser("New question", "Next answer"));

    state = applyTimelineEvent(state, {
      id: "event-user-2",
      seq: 10,
      kind: "codex.notification",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-2",
      itemId: "user-2",
      projectId: "project-1",
      payload: { item: { id: "user-2", type: "userMessage", content: [{ type: "text", text: "New question" }] } },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.text)).toEqual([
      "Hello",
      "Previous answer",
      "New question",
      "Next answer",
    ]);
    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "user-1",
      "agent-1",
      "optimistic-client-message-1",
      "agent-2",
    ]);
    expect(sortedVisibleTimelineItems(state, false)[2]).toMatchObject({
      serverItemId: "user-2",
      source: "app_server",
    });
  });

  it("keeps snapshot row order when a stale lower-seq live item replays after refresh", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Old answer", "agent-1"));
    state = applyTimelineEvent(state, liveAgentEvent(20, "agent-2", "Streaming answer"));

    state = applyTimelineSnapshot(state, snapshotWithSecondUser("New question", "Streaming answer"));
    expect(sortedVisibleTimelineItems(state, false).map((item) => item.text)).toEqual([
      "Hello",
      "Previous answer",
      "New question",
      "Streaming answer",
    ]);

    state = applyTimelineEvent(state, liveAgentEvent(10, "agent-2", "Streaming answer"));

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.text)).toEqual([
      "Hello",
      "Previous answer",
      "New question",
      "Streaming answer",
    ]);
    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "user-1",
      "agent-1",
      "user-2",
      "agent-2",
    ]);
  });

  it("does not let stale non-delta live starts regress completed snapshot text", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshotWithSecondUser("New question", "Streaming answer"));

    state = applyTimelineEvent(state, liveAgentEvent(1, "agent-2", "Partial answer"));

    const agent = sortedVisibleTimelineItems(state, false).find((item) => item.id === "agent-2");
    expect(agent).toMatchObject({
      status: "completed",
      text: "Streaming answer",
    });
  });

  it("keeps a newer same-text local user message when a stale direct server event replays", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Previous answer", "agent-1"));
    state = addOptimisticUserMessage(state, {
      clientRequestId: "client-message-1",
      images: [],
      text: "Hello",
      turnId: null,
      confirmationState: "sending",
    });

    state = applyTimelineEvent(state, {
      id: "event-user-1-replay",
      seq: 1,
      kind: "codex.notification",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-1",
      projectId: "project-1",
      payload: { item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Hello" }] } },
      receivedAt: "2026-04-30T00:00:01Z",
    });

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "user-1",
      "agent-1",
      "optimistic-client-message-1",
    ]);
  });

  it("reconciles a direct-confirmed local user message when a later snapshot includes its server item", () => {
    let state = addOptimisticUserMessage(createTimelineState(), {
      clientRequestId: "client-message-1",
      images: [],
      text: "Hello",
      turnId: null,
      confirmationState: "sending",
    });
    state = applyTimelineEvent(state, {
      id: "event-user-1",
      seq: 1,
      kind: "codex.notification",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-1",
      projectId: "project-1",
      payload: { item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Hello" }] } },
      receivedAt: "2026-04-30T00:00:00Z",
    });

    state = applyTimelineSnapshot(state, snapshot("Previous answer", "agent-1"));

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "optimistic-client-message-1",
      "agent-1",
    ]);
    expect(sortedVisibleTimelineItems(state, false)[0]).toMatchObject({
      serverItemId: "user-1",
      source: "app_server",
    });
  });

  it("confirms a same-turn duplicate local user message before matching an older equivalent user message", () => {
    let state = applyTimelineEvent(createTimelineState(), {
      id: "event-user-1",
      seq: 1,
      kind: "codex.notification",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-1",
      projectId: "project-1",
      payload: { item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Hello" }] } },
      receivedAt: "2026-04-30T00:00:00Z",
    });
    state = addOptimisticUserMessage(state, {
      clientRequestId: "client-message-1",
      images: [],
      text: "Hello",
      turnId: "turn-1",
      confirmationState: "sending",
    });

    state = applyTimelineEvent(state, {
      id: "event-user-2",
      seq: 2,
      kind: "codex.notification",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-2",
      projectId: "project-1",
      payload: { item: { id: "user-2", type: "userMessage", content: [{ type: "text", text: "Hello" }] } },
      receivedAt: "2026-04-30T00:00:01Z",
    });

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.id)).toEqual([
      "user-1",
      "optimistic-client-message-1",
    ]);
    expect(sortedVisibleTimelineItems(state, false).map((item) => item.serverItemId)).toEqual([
      undefined,
      "user-2",
    ]);
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
    expect(state.turns).toMatchObject([{ turnId: "turn-1", itemIds: ["agent-1"] }]);
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
    expect(state.turns).toMatchObject([{ turnId: "turn-1", itemIds: ["user-1", "agent-1"] }]);
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
    expect(state.turns).toMatchObject([{ turnId: "turn-1", itemIds: ["user-1", "agent-1"] }]);
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
    expect(state.turns).toMatchObject([{ turnId: "turn-1", itemIds: ["agent-stream-1"] }]);
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
    expect(state.turns).toMatchObject([
      { turnId: "turn-1", itemIds: ["user-1", "agent-1"] },
      { turnId: "turn-2", itemIds: ["agent-live-1"] },
    ]);
  });

  it("keeps active-turn assistant deltas after refreshed snapshot history", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Previous answer", "agent-1"));
    state = applyTimelineEvent(state, {
      id: "live-turn-upsert-1",
      seq: 100,
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

    state = applyTimelineSnapshot(state, snapshotWithPreviousAndRunningUser("New question"));
    state = applyTimelineEvent(state, {
      id: "live-agent-delta-1",
      seq: 101,
      kind: "timeline.item_delta",
      codexMethod: "item/agentMessage/delta",
      threadId: "thread-1",
      turnId: "turn-2",
      itemId: "agent-live-1",
      projectId: null,
      payload: {
        source: "gatewayStream",
        type: "agentMessage",
        delta: "I'll investigate",
        rawPayload: { delta: "I'll investigate" },
      },
      receivedAt: "2026-04-30T00:00:02Z",
    });

    expect(sortedVisibleTimelineItems(state, false).map((item) => item.text)).toEqual([
      "Hello",
      "Previous answer",
      "New question",
      "I'll investigate",
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

function snapshotWithSkillMention(): ThreadDetailResponse {
  return {
    ...snapshot("Done", "agent-1"),
    turns: [
      {
        id: "turn-skill",
        status: "completed",
        startedAt: 1,
        completedAt: 2,
        rawPayload: {},
        items: [
          {
            id: "user-skill",
            itemType: "userMessage",
            skillMentions: [
              {
                start: "Use ".length,
                end: "Use $agent-browser".length,
                name: "agent-browser",
                path: "/skills/agent-browser/SKILL.md",
                displayName: "Agent Browser",
                shortDescription: "Browser automation",
              },
            ],
            rawPayload: {
              id: "user-skill",
              type: "userMessage",
              content: [{ type: "text", text: "Use $agent-browser now" }],
            },
          },
          {
            id: "agent-skill",
            itemType: "agentMessage",
            rawPayload: { id: "agent-skill", type: "agentMessage", text: "Done" },
          },
        ],
      },
    ],
  };
}

function snapshotWithSecondUser(userText: string, agentText: string): ThreadDetailResponse {
  return {
    ...snapshot("Previous answer", "agent-1"),
    turns: [
      ...snapshot("Previous answer", "agent-1").turns,
      {
        id: "turn-2",
        status: "completed",
        startedAt: 3,
        completedAt: 4,
        rawPayload: {},
        items: [
          {
            id: "user-2",
            itemType: "userMessage",
            rawPayload: { id: "user-2", type: "userMessage", content: [{ type: "text", text: userText }] },
          },
          {
            id: "agent-2",
            itemType: "agentMessage",
            rawPayload: { id: "agent-2", type: "agentMessage", text: agentText },
          },
        ],
      },
    ],
  };
}

function snapshotWithUserOnlyTurn(userText: string): ThreadDetailResponse {
  return {
    ...snapshot("Previous answer", "agent-1"),
    liveState: "streaming",
    turns: [
      {
        id: "turn-1",
        status: "running",
        startedAt: 1,
        completedAt: null,
        rawPayload: {},
        items: [
          {
            id: "user-1",
            itemType: "userMessage",
            rawPayload: { id: "user-1", type: "userMessage", content: [{ type: "text", text: userText }] },
          },
        ],
      },
    ],
  };
}

function snapshotWithPreviousAndRunningUser(userText: string): ThreadDetailResponse {
  const previous = snapshot("Previous answer", "agent-1");
  return {
    ...previous,
    liveState: "streaming",
    turns: [
      ...previous.turns,
      {
        id: "turn-2",
        status: "running",
        startedAt: 3,
        completedAt: null,
        rawPayload: {},
        items: [
          {
            id: "user-2",
            itemType: "userMessage",
            rawPayload: { id: "user-2", type: "userMessage", content: [{ type: "text", text: userText }] },
          },
        ],
      },
    ],
  };
}

function liveAgentEvent(seq: number, itemId: string, text: string) {
  return {
    id: `live-agent-${seq}-${itemId}`,
    seq,
    kind: "timeline.item_upsert",
    codexMethod: "item/started",
    threadId: "thread-1",
    turnId: "turn-2",
    itemId,
    projectId: "project-1",
    payload: { item: { id: itemId, type: "agentMessage", text } },
    receivedAt: "2026-04-30T00:00:00Z",
  };
}
