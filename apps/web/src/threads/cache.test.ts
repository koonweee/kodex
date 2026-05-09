import { describe, expect, it } from "vitest";

import { createKodexQueryClient } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import type { ThreadRead, ThreadSummary } from "../api/client";
import {
  applyThreadPinState,
  applyThreadReadState,
  findCachedThread,
  mergeChatThreadSnapshot,
  mergePinnedThreadData,
  mergeProjectThreadSnapshot,
  pinnedTombstonesAddedDuringSnapshot,
  removeThreadEverywhere,
  upsertChatThread,
  upsertProjectThread,
} from "./cache";

function thread(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    createdAt: 1,
    cwd: "/tmp/kodex",
    id,
    name: id,
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

  it("replaces duplicate live upserts without adding another row", () => {
    const queryClient = createKodexQueryClient();
    upsertProjectThread(queryClient, "project-1", thread("thread-live", { name: "Initial" }));

    upsertProjectThread(queryClient, "project-1", thread("thread-live", { name: "Updated" }));

    expect(queryClient.getQueryData(queryKeys.projectThreads("project-1"))).toEqual([
      thread("thread-live", { name: "Updated" }),
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
