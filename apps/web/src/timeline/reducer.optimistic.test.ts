import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addOptimisticUserMessage,
  createTimelineState,
  removeOptimisticUserMessage,
  updateOptimisticUserMessage,
} from "./reducer";
import { applyTimelineEvent } from "./reducer.testUtils";

describe("timeline reducer optimistic", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("adds optimistic user messages and reconciles matching app-server events", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-30T00:00:05Z"));
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
      timestampMs: Date.parse("2026-04-30T00:00:05Z"),
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
      timestampMs: Date.parse("2026-04-30T00:00:05Z"),
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

  it("does not let stale same-text user replay confirm a newer optimistic message", () => {
    let state = createTimelineState();
    const historicalUserMessage = {
      id: "event-user-1",
      seq: 1,
      kind: "codex.notification",
      codexMethod: "item/completed",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "user-1",
      projectId: "project-1",
      payload: { item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "Again" }] } },
      receivedAt: "2026-04-30T00:00:00Z",
    } satisfies Parameters<typeof applyTimelineEvent>[1];

    state = applyTimelineEvent(state, historicalUserMessage);
    state = addOptimisticUserMessage(state, {
      clientRequestId: "client-same-text",
      images: [],
      text: "Again",
      turnId: null,
      confirmationState: "sending",
    });
    state = applyTimelineEvent(state, { ...historicalUserMessage, id: "event-user-1-replay", seq: 2 });

    expect(state.items).toHaveLength(2);
    expect(state.items[0]).toMatchObject({
      id: "user-1",
    });
    expect(state.items[1]).toMatchObject({
      id: "optimistic-client-same-text",
      source: "optimistic",
    });
    expect(state.items[1]).not.toHaveProperty("serverItemId");
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

});
