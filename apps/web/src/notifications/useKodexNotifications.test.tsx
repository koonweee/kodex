import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope, ThreadSummary } from "../api/client";
import { useKodexNotifications } from "./useKodexNotifications";

const OriginalNotification = globalThis.Notification;

afterEach(() => {
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: OriginalNotification });
});

function thread(id: string, unreadCompletedAgentTurn = false): ThreadSummary {
  return {
    id,
    name: id,
    cwd: "/workspace",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    source: "local",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    approvalPolicy: null,
    approvalsReviewer: null,
    agentNickname: null,
    agentRole: null,
    sandbox: null,
    gitInfo: null,
    pinnedAt: null,
    preview: null,
    lastCompletedAgentTurnSeq: unreadCompletedAgentTurn ? 1 : null,
    seenCompletedAgentTurnSeq: 0,
    unreadCompletedAgentTurn,
    rawPayload: {},
  };
}

function completedTurnEvent(threadId: string): EventEnvelope {
  return {
    id: `event-${threadId}`,
    seq: 2,
    kind: "thread_view.patch",
    codexMethod: "thread_view/patch",
    projectId: null,
    threadId,
    turnId: null,
    itemId: null,
    receivedAt: "2026-05-15T00:00:00Z",
    payload: { viewRevision: 2, threadId, activeTurnId: null, liveState: "idle", items: [] },
  };
}

describe("useKodexNotifications", () => {
  it("sets a deduped app badge for unread agent messages", async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    const originalSet = navigator.setAppBadge;
    const originalClear = navigator.clearAppBadge;
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: setAppBadge });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: clearAppBadge });

    const unread = thread("thread-1", true);
    renderHook(() =>
      useKodexNotifications({
        chatThreads: [unread],
        pinnedThreads: [unread],
        routeSelectedThread: null,
        selectedThreadId: null,
        threadsByProjectId: {},
      }),
    );

    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1));
    expect(clearAppBadge).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: originalSet });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: originalClear });
  });

  it("suppresses foreground notifications for the selected thread", () => {
    const notificationCtor = vi.fn();
    Object.defineProperty(notificationCtor, "permission", { configurable: true, value: "granted" });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: notificationCtor });

    const { result } = renderHook(() =>
      useKodexNotifications({
        chatThreads: [thread("thread-1")],
        pinnedThreads: [],
        routeSelectedThread: null,
        selectedThreadId: "thread-1",
        threadsByProjectId: {},
      }),
    );

    act(() => result.current.applyNotificationEvent(completedTurnEvent("thread-1")));

    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("shows foreground notifications for background completed agent turns", () => {
    const notificationCtor = vi.fn();
    Object.defineProperty(notificationCtor, "permission", { configurable: true, value: "granted" });
    Object.defineProperty(globalThis, "Notification", { configurable: true, value: notificationCtor });

    const { result } = renderHook(() =>
      useKodexNotifications({
        chatThreads: [thread("thread-2")],
        pinnedThreads: [],
        routeSelectedThread: null,
        selectedThreadId: "thread-1",
        threadsByProjectId: {},
      }),
    );

    act(() => result.current.applyNotificationEvent(completedTurnEvent("thread-2")));

    expect(notificationCtor).toHaveBeenCalledWith(
      "thread-2",
      expect.objectContaining({
        body: "Agent has a new message.",
        tag: "kodex-unread-agent-message:thread-2",
      }),
    );
  });
});
