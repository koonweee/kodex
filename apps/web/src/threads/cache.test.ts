import { describe, expect, it } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import type { ThreadRead, ThreadSummary } from "../api/client";
import {
  applyThreadNotificationsState,
  applyThreadPinState,
  applyThreadReadState,
  findCachedThread,
  mergeChatThreadSnapshot,
  mergePinnedThreadData,
  mergeProjectThreadSnapshot,
  pinnedTombstonesAddedDuringSnapshot,
  removeThreadEverywhere,
  replaceThreadEverywhere,
  upsertChatThread,
  upsertProjectThread,
  updateThreadEverywhere,
} from "./cache";

function thread(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    createdAt: 1,
    cwd: "/tmp/kodex",
    id,
    name: id,
    notificationsEnabled: true,
    rawPayload: {},
    seenCompletedAgentTurnSeq: 0,
    status: "idle",
    unreadCompletedAgentTurn: false,
    updatedAt: 1,
    ...overrides,
  };
}

function read(threadId: string, seenCompletedAgentTurnSeq: number): ThreadRead {
  return {
    seenCompletedAgentTurnSeq,
    threadId,
    updatedAt: "2026-05-05T00:00:00Z",
  };
}

describe("thread query cache helpers", () => {
  it("preserves a selected route thread when a stale project snapshot resolves later", () => {
    const queryClient = createKodexQueryClient();
    const routeThread = thread("thread-route", { name: "Fresh route title" });
    queryClient.setQueryData(queryKeys.projectThreads("project-1"), [routeThread]);

    mergeProjectThreadSnapshot(queryClient, "project-1", [thread("thread-old")], routeThread, routeThread.id);

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([
      routeThread,
      thread("thread-old"),
    ]);
  });

  it("keeps a locally created chat when the initial chat snapshot resolves later", () => {
    const queryClient = createKodexQueryClient();
    const localChat = thread("chat-local", { preview: "Local prompt" });
    upsertChatThread(queryClient, localChat);

    mergeChatThreadSnapshot(queryClient, []);

    expect(queryClient.getQueryData(queryKeys.chatThreads)).toEqual([localChat]);
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

  it("keeps a live-created project thread when the initial project snapshot resolves later", () => {
    const queryClient = createKodexQueryClient();
    const liveThread = thread("thread-live", { preview: "Live prompt" });
    upsertProjectThread(queryClient, "project-1", liveThread);

    mergeProjectThreadSnapshot(queryClient, "project-1", [thread("thread-old")], null, null);

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([
      liveThread,
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
        lastCompletedAgentTurnSeq: 2,
        name: "Detail title",
        seenCompletedAgentTurnSeq: 1,
        unreadCompletedAgentTurn: true,
        updatedAt: 100,
      }),
    );

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([
      thread("thread-selected", {
        createdAt: 50,
        lastCompletedAgentTurnSeq: 2,
        name: "Detail title",
        seenCompletedAgentTurnSeq: 1,
        unreadCompletedAgentTurn: true,
        updatedAt: 300,
      }),
    ]);
  });

  it("applies pin state across normal lists and the pinned cache", () => {
    const queryClient = createKodexQueryClient();
    const projectThread = thread("thread-1");
    upsertProjectThread(queryClient, "project-1", projectThread);

    applyThreadPinState(queryClient, "thread-1", "2026-05-06T12:00:00Z");

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]?.pinnedAt).toBe(
      "2026-05-06T12:00:00Z",
    );
    expect(queryClient.getQueryData(queryKeys.pinnedThreads)).toEqual([
      { ...projectThread, pinnedAt: "2026-05-06T12:00:00Z" },
    ]);
  });

  it("updates notification settings in every cached copy", () => {
    const queryClient = createKodexQueryClient();
    const cachedThread = thread("thread-1", { pinnedAt: "2026-05-06T12:00:00Z", preview: "Keep me" });
    upsertProjectThread(queryClient, "project-1", cachedThread);
    upsertChatThread(queryClient, cachedThread);
    applyThreadPinState(queryClient, "thread-1", cachedThread.pinnedAt ?? null, cachedThread);

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
    const cachedThread = thread("thread-1", { pinnedAt: "2026-05-06T12:00:00Z" });
    upsertProjectThread(queryClient, "project-1", cachedThread);
    upsertChatThread(queryClient, cachedThread);
    upsertProjectThread(queryClient, "project-2", thread("thread-2"));
    applyThreadPinState(queryClient, "thread-1", cachedThread.pinnedAt ?? null, cachedThread);
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

  it("preserves a live pin when a stale pinned snapshot resolves later", () => {
    const livePinnedThread = thread("thread-1", {
      pinnedAt: "2026-05-06T12:00:00Z",
      updatedAt: 2,
    });

    expect(mergePinnedThreadData([], [livePinnedThread], [])).toEqual([livePinnedThread]);
  });

  it("does not resurrect a live unpin when a stale pinned snapshot resolves later", () => {
    const stalePinnedThread = thread("thread-1", {
      pinnedAt: "2026-05-06T12:00:00Z",
      updatedAt: 1,
    });

    expect(mergePinnedThreadData([stalePinnedThread], [], [stalePinnedThread])).toEqual([]);
  });

  it("does not resurrect an uncached live unpin when a stale pinned snapshot resolves later", () => {
    const queryClient = createKodexQueryClient();
    const stalePinnedThread = thread("thread-1", {
      pinnedAt: "2026-05-06T12:00:00Z",
      updatedAt: 1,
    });

    applyThreadPinState(queryClient, "thread-1", null);

    expect(
      mergePinnedThreadData(
        undefined,
        undefined,
        [stalePinnedThread],
        queryClient.getQueryData<string[]>(queryKeys.pinnedThreadTombstones),
      ),
    ).toEqual([]);
  });

  it("only applies pinned tombstones added while a snapshot was in flight", () => {
    expect(pinnedTombstonesAddedDuringSnapshot(["thread-before"], ["thread-before", "thread-during"])).toEqual([
      "thread-during",
    ]);
  });

  it("allows a later authoritative snapshot to re-add a thread with an older tombstone", () => {
    const stalePinnedThread = thread("thread-1", {
      pinnedAt: "2026-05-06T12:00:00Z",
      updatedAt: 1,
    });

    expect(mergePinnedThreadData(undefined, undefined, [stalePinnedThread], [])).toEqual([stalePinnedThread]);
  });

  it("removes unpinned threads from the pinned cache and clears normal list pin state", () => {
    const queryClient = createKodexQueryClient();
    const pinnedThread = thread("thread-1", { pinnedAt: "2026-05-06T12:00:00Z" });
    upsertProjectThread(queryClient, "project-1", pinnedThread);
    applyThreadPinState(queryClient, "thread-1", pinnedThread.pinnedAt ?? null, pinnedThread);

    applyThreadPinState(queryClient, "thread-1", null);

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]?.pinnedAt).toBeNull();
    expect(queryClient.getQueryData(queryKeys.pinnedThreads)).toEqual([]);
  });

  it("updates read state in every cached copy", () => {
    const queryClient = createKodexQueryClient();
    const unreadThread = thread("thread-1", { unreadCompletedAgentTurn: true });
    upsertProjectThread(queryClient, "project-1", unreadThread);
    upsertChatThread(queryClient, unreadThread);

    applyThreadReadState(queryClient, "thread-1", read("thread-1", 42));

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]).toMatchObject({
      seenCompletedAgentTurnSeq: 42,
      unreadCompletedAgentTurn: false,
    });
    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.chatThreads)?.[0]).toMatchObject({
      seenCompletedAgentTurnSeq: 42,
      unreadCompletedAgentTurn: false,
    });
  });

  it("keeps gateway unread events ahead of a stale sidebar snapshot without local turn counting", () => {
    const queryClient = createKodexQueryClient();
    upsertProjectThread(queryClient, "project-1", thread("thread-1"));

    applyThreadReadState(queryClient, "thread-1", {
      threadId: "thread-1",
      seenCompletedAgentTurnSeq: 0,
      lastCompletedAgentTurnSeq: null,
      unreadCompletedAgentTurn: true,
    });
    mergeProjectThreadSnapshot(queryClient, "project-1", [thread("thread-1")], null, null);

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]).toMatchObject({
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: true,
    });
  });

  it("keeps gateway read events ahead of a stale unread sidebar snapshot", () => {
    const queryClient = createKodexQueryClient();
    upsertProjectThread(
      queryClient,
      "project-1",
      thread("thread-1", {
        lastCompletedAgentTurnSeq: 2,
        seenCompletedAgentTurnSeq: 1,
        unreadCompletedAgentTurn: true,
      }),
    );

    applyThreadReadState(queryClient, "thread-1", {
      threadId: "thread-1",
      seenCompletedAgentTurnSeq: 2,
      lastCompletedAgentTurnSeq: 2,
      unreadCompletedAgentTurn: false,
    });
    mergeProjectThreadSnapshot(
      queryClient,
      "project-1",
      [
        thread("thread-1", {
          lastCompletedAgentTurnSeq: 2,
          seenCompletedAgentTurnSeq: 1,
          unreadCompletedAgentTurn: true,
        }),
      ],
      null,
      null,
    );

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]).toMatchObject({
      lastCompletedAgentTurnSeq: 2,
      seenCompletedAgentTurnSeq: 2,
      unreadCompletedAgentTurn: false,
    });
  });

  it("does not let an older read-clear event erase a newer unread event", () => {
    const queryClient = createKodexQueryClient();
    upsertProjectThread(queryClient, "project-1", thread("thread-1"));
    applyThreadReadState(queryClient, "thread-1", {
      threadId: "thread-1",
      seenCompletedAgentTurnSeq: 0,
      lastCompletedAgentTurnSeq: null,
      unreadCompletedAgentTurn: true,
    }, 2);

    applyThreadReadState(queryClient, "thread-1", {
      threadId: "thread-1",
      seenCompletedAgentTurnSeq: 0,
      lastCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: false,
    }, 1);

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]).toMatchObject({
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: true,
    });
  });

  it("allows a newer read-clear event to clear the same read watermark", () => {
    const queryClient = createKodexQueryClient();
    upsertProjectThread(queryClient, "project-1", thread("thread-1"));
    applyThreadReadState(queryClient, "thread-1", {
      threadId: "thread-1",
      seenCompletedAgentTurnSeq: 1,
      lastCompletedAgentTurnSeq: 1,
      unreadCompletedAgentTurn: true,
    }, 2);

    applyThreadReadState(queryClient, "thread-1", {
      threadId: "thread-1",
      seenCompletedAgentTurnSeq: 1,
      lastCompletedAgentTurnSeq: 1,
      unreadCompletedAgentTurn: false,
    }, 3);

    expect(queryClient.getQueryData<ThreadSummary[]>(queryKeys.projectThreads("project-1"))?.[0]).toMatchObject({
      seenCompletedAgentTurnSeq: 1,
      unreadCompletedAgentTurn: false,
    });
  });

  it("removes archived threads from every sidebar cache", () => {
    const queryClient = createKodexQueryClient();
    const cachedThread = thread("thread-1", { pinnedAt: "2026-05-06T12:00:00Z" });
    upsertProjectThread(queryClient, "project-1", cachedThread);
    upsertChatThread(queryClient, cachedThread);
    applyThreadPinState(queryClient, "thread-1", cachedThread.pinnedAt ?? null, cachedThread);

    removeThreadEverywhere(queryClient, "thread-1");

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([]);
    expect(queryClient.getQueryData(queryKeys.chatThreads)).toEqual([]);
    expect(queryClient.getQueryData(queryKeys.pinnedThreads)).toEqual([]);
    expect(findCachedThread(queryClient, "thread-1")).toBeNull();
  });
});
