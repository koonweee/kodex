import { describe, expect, it } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import type { ThreadRead, ThreadSummary } from "../api/client";
import {
  applyThreadNotificationsState,
  findCachedThread,
  mergeChatThreadSnapshot,
  mergeProjectThreadSnapshot,
  removeThreadEverywhere,
  replaceThreadEverywhere,
  upsertChatThread,
  upsertProjectThread,
  updateThreadEverywhere,
} from "./cache";
import { mergeThreadReadState } from "./readState";

function thread(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    parentThreadId: null, canAcceptDirectInput: null,
    createdAt: 1,
    cwd: "/tmp/kodex",
    id,
    name: id,
    notificationsEnabled: true,
    projectId: null,
    pinned: false,

    rawPayload: {},
    latestCompletedTurnId: null,
    seenCompletedTurnId: null,
    readRevision: 0,
    readStateKnown: true,
    status: "idle",
    unreadCompletedAgentTurn: false,
    updatedAt: 1,
    ...overrides,
  };
}

function read(threadId: string, revision: number): ThreadRead {
  return {
    latestCompletedTurnId: `turn-${revision}`, seenCompletedTurnId: `turn-${revision}`,
    readRevision: revision, readStateKnown: true, unreadCompletedAgentTurn: false,
    threadId, updatedAt: "2026-10-05T00:00:00Z",
  };
}

describe("thread query cache helpers", () => {
  it("keeps canonical pinned membership and native row order when a late summary has stale membership", () => {
    const client = createKodexQueryClient();
    const assigned = thread("thread-1", { projectId: "project-1", pinned: true });
    const sibling = thread("thread-2", { pinned: assigned.pinned });
    client.setQueryData(queryKeys.pinnedThreads, [sibling, assigned]);
    replaceThreadEverywhere(client, { ...assigned, name: "New title", projectId: null, pinned: false, updatedAt: 30 });
    expect(client.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads)?.map((row) => row.id)).toEqual([sibling.id, assigned.id]);
    expect(client.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads)?.[1]).toMatchObject({ name: "New title", projectId: "project-1", pinned: assigned.pinned });
    expect(client.getQueryData(queryKeys.chatThreads)).toBeUndefined();
  });
  it("takes refreshed native preview and name while preserving only the selected route's newer read tuple", () => {
    const client = createKodexQueryClient();
    const route = thread("fresh", { name: "New thread", preview: null, projectId: "project-1", readRevision: 8, readStateKnown: true, latestCompletedTurnId: "new-head" });
    const native = thread("fresh", { name: "Explicit native name", preview: "Persisted first input", projectId: "project-1", readRevision: 2, latestCompletedTurnId: "old-head" });
    mergeProjectThreadSnapshot(client, "project-1", [native], route, route.id);
    expect(client.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0])
      .toMatchObject({ name: "Explicit native name", preview: "Persisted first input", readRevision: 8, latestCompletedTurnId: "new-head" });
  });
  it("preserves an acknowledged native rename received during a same-timestamp sidebar read, then accepts a later native clear", () => {
    const client = createKodexQueryClient();
    const before = thread("renamed", { name: null, preview: "Persisted prompt", projectId: "project-1", updatedAt: 7 });
    const renamed = { ...before, name: "Explicit native name" };
    upsertProjectThread(client, "project-1", renamed);
    mergeProjectThreadSnapshot(client, "project-1", [before], renamed, renamed.id, [before]);
    expect(client.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0].name).toBe("Explicit native name");
    mergeProjectThreadSnapshot(client, "project-1", [before], renamed, renamed.id, [renamed]);
    expect(client.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0].name).toBeNull();
  });
  it("removes a selected route thread absent from the authoritative project membership", () => {
    const queryClient = createKodexQueryClient();
    const routeThread = thread("thread-route", { name: "Fresh route title" });
    queryClient.setQueryData(queryKeys.projectThreads("project-1"), [routeThread]);

    mergeProjectThreadSnapshot(queryClient, "project-1", [thread("thread-old")], routeThread, routeThread.id);

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([
      thread("thread-old"),
    ]);
  });

  it("replaces chat membership with an authoritative empty snapshot", () => {
    const queryClient = createKodexQueryClient();
    const localChat = thread("chat-local", { preview: "Local prompt" });
    upsertChatThread(queryClient, localChat);

    mergeChatThreadSnapshot(queryClient, []);

    expect(queryClient.getQueryData(queryKeys.chatThreads)).toEqual([]);
  });

  it("keeps a newer cached chat when a stale chat snapshot resolves later", () => {
    const queryClient = createKodexQueryClient();
    const staleChat = thread("chat-live", { name: "Stale", updatedAt: 1 });
    const liveChat = thread("chat-live", { name: "Live", updatedAt: 2 });
    upsertChatThread(queryClient, liveChat);

    mergeChatThreadSnapshot(queryClient, [staleChat]);

    expect(queryClient.getQueryData(queryKeys.chatThreads)).toEqual([liveChat]);
  });

  it("accepts a newer chat snapshot over a stale cached chat", () => {
    const queryClient = createKodexQueryClient();
    const staleChat = thread("chat-live", { name: "Stale", updatedAt: 1 });
    const snapshotChat = thread("chat-live", { name: "Snapshot", updatedAt: 2 });
    upsertChatThread(queryClient, staleChat);

    mergeChatThreadSnapshot(queryClient, [snapshotChat]);

    expect(queryClient.getQueryData(queryKeys.chatThreads)).toEqual([snapshotChat]);
  });

  it("removes project members absent from the authoritative replacement", () => {
    const queryClient = createKodexQueryClient();
    const liveThread = thread("thread-live", { preview: "Live prompt" });
    upsertProjectThread(queryClient, "project-1", liveThread);

    mergeProjectThreadSnapshot(queryClient, "project-1", [thread("thread-old")], null, null);

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([
      thread("thread-old"),
    ]);
  });

  it("keeps a newer cached project thread when a stale project snapshot resolves later", () => {
    const queryClient = createKodexQueryClient();
    const staleThread = thread("thread-live", { name: "Stale", updatedAt: 1 });
    const liveThread = thread("thread-live", { name: "Live", updatedAt: 2 });
    upsertProjectThread(queryClient, "project-1", liveThread);

    mergeProjectThreadSnapshot(queryClient, "project-1", [staleThread], null, null);

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([liveThread]);
  });

  it("accepts a newer project snapshot over a stale cached project thread", () => {
    const queryClient = createKodexQueryClient();
    const staleThread = thread("thread-live", { name: "Stale", updatedAt: 1 });
    const snapshotThread = thread("thread-live", { name: "Snapshot", updatedAt: 2 });
    upsertProjectThread(queryClient, "project-1", staleThread);

    mergeProjectThreadSnapshot(queryClient, "project-1", [snapshotThread], null, null);

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([snapshotThread]);
  });

  it("replaces duplicate live upserts without adding another row", () => {
    const queryClient = createKodexQueryClient();
    upsertProjectThread(queryClient, "project-1", thread("thread-live", { name: "Initial" }));

    upsertProjectThread(queryClient, "project-1", thread("thread-live", { name: "Updated" }));

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([
      thread("thread-live", { name: "Updated" }),
    ]);
  });

  it("merges selected detail without regressing sidebar ordering timestamps", () => {
    const queryClient = createKodexQueryClient();
    const sidebarThread = thread("thread-selected", {
      createdAt: 50,
      name: "Sidebar title",
      updatedAt: 300,
    });
    upsertProjectThread(queryClient, "project-1", sidebarThread);

    replaceThreadEverywhere(
      queryClient,
      thread("thread-selected", {
        createdAt: 40,
        latestCompletedTurnId: "turn-2",
        readRevision: 2,
        name: "Detail title",
        seenCompletedTurnId: "turn-1",
        unreadCompletedAgentTurn: true,
        updatedAt: 100,
      }),
    );

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([
      thread("thread-selected", {
        createdAt: 50,
        latestCompletedTurnId: "turn-2",
        readRevision: 2,
        name: "Detail title",
        seenCompletedTurnId: "turn-1",
        unreadCompletedAgentTurn: true,
        updatedAt: 300,
      }),
    ]);
  });

  it("updates notification settings in every cached copy", () => {
    const queryClient = createKodexQueryClient();
    const cachedThread = thread("thread-1", { pinned: true, preview: "Keep me" });
    upsertProjectThread(queryClient, "project-1", cachedThread);
    upsertChatThread(queryClient, cachedThread);
    queryClient.setQueryData(queryKeys.pinnedThreads, [cachedThread]);

    applyThreadNotificationsState(queryClient, "thread-1", false);

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]).toMatchObject({
      notificationsEnabled: false,
      preview: "Keep me",
    });
    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)?.[0]).toMatchObject({
      notificationsEnabled: false,
      preview: "Keep me",
    });
    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads)?.[0]).toMatchObject({
      notificationsEnabled: false,
      preview: "Keep me",
    });
  });

  it("preserves cached list references when an everywhere update is a no-op", () => {
    const queryClient = createKodexQueryClient();
    const cachedThread = thread("thread-1", { pinned: true });
    upsertProjectThread(queryClient, "project-1", cachedThread);
    upsertChatThread(queryClient, cachedThread);
    upsertProjectThread(queryClient, "project-2", thread("thread-2"));
    queryClient.setQueryData(queryKeys.pinnedThreads, [cachedThread]);
    const projectThreads = queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"));
    const otherProjectThreads = queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-2"));
    const chatThreads = queryClient.getQueryData<ThreadSummary[]>(queryKeys.chatThreads);
    const pinnedThreads = queryClient.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads);

    updateThreadEverywhere(queryClient, "thread-1", (current) => current);

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))).toBe(projectThreads);
    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-2"))).toBe(otherProjectThreads);
    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)).toBe(chatThreads);
    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.pinnedThreads)).toBe(pinnedThreads);
  });

  it("keeps local notification settings ahead of stale sidebar snapshots", () => {
    const queryClient = createKodexQueryClient();
    upsertProjectThread(queryClient, "project-1", thread("thread-1", { notificationsEnabled: true }));
    const beforeSnapshot = queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"));
    applyThreadNotificationsState(queryClient, "thread-1", false);

    mergeProjectThreadSnapshot(
      queryClient,
      "project-1",
      [thread("thread-1", { notificationsEnabled: true })],
      null,
      null,
      beforeSnapshot,
    );

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]).toMatchObject({
      notificationsEnabled: false,
    });
  });

  it("accepts authoritative notification settings from later sidebar snapshots", () => {
    const queryClient = createKodexQueryClient();
    upsertProjectThread(queryClient, "project-1", thread("thread-1", { notificationsEnabled: true }));

    mergeProjectThreadSnapshot(
      queryClient,
      "project-1",
      [thread("thread-1", { notificationsEnabled: false })],
      null,
      null,
    );

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]).toMatchObject({
      notificationsEnabled: false,
    });
  });

  it("updates the complete read tuple in every cached copy", () => {
    const queryClient = createKodexQueryClient();
    const unreadThread = thread("thread-1", { latestCompletedTurnId: "turn-42", unreadCompletedAgentTurn: true });
    upsertProjectThread(queryClient, "project-1", unreadThread);
    upsertChatThread(queryClient, unreadThread);
    queryClient.setQueryData(queryKeys.pinnedThreads, [unreadThread]);
    const state = read("thread-1", 42);
    updateThreadEverywhere(queryClient, "thread-1", (thread) => mergeThreadReadState(thread, state));
    for (const key of [queryKeys.projectThreads("project-1"), queryKeys.chatThreads, queryKeys.pinnedThreads]) {
      expect(queryClient.getQueryData<ThreadSummary[]>(key)?.[0]).toMatchObject({
        latestCompletedTurnId: "turn-42", seenCompletedTurnId: "turn-42", readRevision: 42,
        readStateKnown: true, unreadCompletedAgentTurn: false,
      });
    }
  });

  it("keeps authoritative unread and seen events ahead of stale sidebar snapshots", () => {
    const queryClient = createKodexQueryClient();
    const initial = thread("thread-1");
    upsertProjectThread(queryClient, "project-1", initial);
    const unread = { ...read("thread-1", 2), seenCompletedTurnId: null, unreadCompletedAgentTurn: true };
    updateThreadEverywhere(queryClient, "thread-1", (thread) => mergeThreadReadState(thread, unread));
    mergeProjectThreadSnapshot(queryClient, "project-1", [initial], null, null);
    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]).toMatchObject({
      latestCompletedTurnId: "turn-2", readRevision: 2, seenCompletedTurnId: null, unreadCompletedAgentTurn: true,
    });
    updateThreadEverywhere(queryClient, "thread-1", (thread) => mergeThreadReadState(thread, { ...unread, readRevision: 3, seenCompletedTurnId: "turn-2", unreadCompletedAgentTurn: false }));
    mergeProjectThreadSnapshot(queryClient, "project-1", [{ ...initial, ...unread, id: initial.id, updatedAt: 10 }], null, null);
    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]).toMatchObject({
      latestCompletedTurnId: "turn-2", readRevision: 3, seenCompletedTurnId: "turn-2", unreadCompletedAgentTurn: false,
    });
  });

  it("removes archived threads from every sidebar cache", () => {
    const queryClient = createKodexQueryClient();
    const cachedThread = thread("thread-1", { pinned: true });
    upsertProjectThread(queryClient, "project-1", cachedThread);
    upsertChatThread(queryClient, cachedThread);
    queryClient.setQueryData(queryKeys.pinnedThreads, [cachedThread]);

    removeThreadEverywhere(queryClient, "thread-1");

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([]);
    expect(queryClient.getQueryData(queryKeys.chatThreads)).toEqual([]);
    expect(queryClient.getQueryData(queryKeys.pinnedThreads)).toEqual([]);
    expect(findCachedThread(queryClient, "thread-1")).toBeNull();
  });
});
