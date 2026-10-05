import { describe, expect, it } from "vitest";

import type { ThreadRead, ThreadSummary } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import { updateThreadEverywhere, mergeChatThreadSnapshot, mergeProjectThreadSnapshot, replaceThreadEverywhere } from "./cache";
import { mergeThreadReadState } from "./readState";

function read(overrides: Partial<ThreadRead> = {}): ThreadRead {
  return {
    threadId: "read-chat", updatedAt: "2026-10-05T00:00:00Z",
    latestCompletedTurnId: "turn-a", seenCompletedTurnId: null,
    readRevision: 10, readStateKnown: true, unreadCompletedAgentTurn: true,
    ...overrides,
  };
}

function thread(state = read(), overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  const { threadId, updatedAt: _readUpdatedAt, ...marker } = state;
  return {
    id: threadId, name: "Read chat", cwd: "/repo", projectId: null,
    parentThreadId: null, canAcceptDirectInput: true, status: "idle",
    createdAt: 1, updatedAt: 1, notificationsEnabled: true, pinned: false, rawPayload: {},
    ...marker, ...overrides,
  };
}

describe("native completion read markers", () => {
  it("keeps both clients on the newer completion when an older seen response arrives", () => {
    const clients = [createKodexQueryClient(), createKodexQueryClient()];
    const completedB = read({ latestCompletedTurnId: "turn-b", seenCompletedTurnId: "turn-a", readRevision: 12 });
    const delayedSeenA = read({ seenCompletedTurnId: "turn-a", unreadCompletedAgentTurn: false, readRevision: 11 });
    for (const client of clients) {
      client.setQueryData(queryKeys.chatThreads, [thread()]);
      updateThreadEverywhere(client, "read-chat", (thread) => mergeThreadReadState(thread, completedB));
      updateThreadEverywhere(client, "read-chat", (thread) => mergeThreadReadState(thread, delayedSeenA));
      expect(client.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)?.[0]).toMatchObject({
        latestCompletedTurnId: "turn-b", seenCompletedTurnId: "turn-a", readRevision: 12,
        readStateKnown: true, unreadCompletedAgentTurn: true,
      });
    }
  });

  it("replaces the whole tuple when native history invalidates or clears its head", () => {
    const client = createKodexQueryClient();
    client.setQueryData(queryKeys.chatThreads, [thread()]);
    updateThreadEverywhere(client, "read-chat", (thread) => mergeThreadReadState(thread, read({
      latestCompletedTurnId: null, seenCompletedTurnId: "turn-a", readRevision: 13,
      readStateKnown: false, unreadCompletedAgentTurn: false,
    })));
    expect(client.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)?.[0]).toMatchObject({
      latestCompletedTurnId: null, seenCompletedTurnId: "turn-a", readRevision: 13,
      readStateKnown: false, unreadCompletedAgentTurn: false,
    });
    replaceThreadEverywhere(client, thread(read({
      latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 14,
      readStateKnown: true, unreadCompletedAgentTurn: false,
    })));
    expect(client.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)?.[0]).toMatchObject({
      latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 14,
      readStateKnown: true, unreadCompletedAgentTurn: false,
    });
  });

  it.each(["chat", "project"] as const)("merges read revisions independently of %s metadata timestamps", (scope) => {
    const client = createKodexQueryClient();
    const key = scope === "chat" ? queryKeys.chatThreads : queryKeys.projectThreads("project");
    const merge = (rows: ThreadSummary[]) => scope === "chat"
      ? mergeChatThreadSnapshot(client, rows)
      : mergeProjectThreadSnapshot(client, "project", rows, null, null);
    client.setQueryData(key, [thread(read(), { name: "Newest title", updatedAt: 50 })]);
    const seen = read({ seenCompletedTurnId: "turn-a", unreadCompletedAgentTurn: false, readRevision: 11 });
    merge([thread(seen, { name: "Older title", updatedAt: 2 })]);
    expect(client.getQueryData<ThreadSummary[]>(key)?.[0]).toMatchObject({
      name: "Newest title", readRevision: 11, seenCompletedTurnId: "turn-a", unreadCompletedAgentTurn: false,
    });
    merge([thread(read(), { name: "Latest title", updatedAt: 60 })]);
    expect(client.getQueryData<ThreadSummary[]>(key)?.[0]).toMatchObject({
      name: "Latest title", readRevision: 11, seenCompletedTurnId: "turn-a", unreadCompletedAgentTurn: false,
    });
  });
});
