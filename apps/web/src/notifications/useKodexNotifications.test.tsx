import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "../api/client";
import { useKodexNotifications } from "./useKodexNotifications";

const OriginalNotification = globalThis.Notification;

afterEach(() => {
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: OriginalNotification });
  localStorage.clear();
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
    notificationsEnabled: true,
    pinnedAt: null,
    preview: null,
    lastCompletedAgentTurnSeq: unreadCompletedAgentTurn ? 1 : null,
    seenCompletedAgentTurnSeq: 0,
    unreadCompletedAgentTurn,
    rawPayload: {},
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
        threadsByProjectId: {},
      }),
    );

    await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(1));
    expect(clearAppBadge).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "setAppBadge", { configurable: true, value: originalSet });
    Object.defineProperty(navigator, "clearAppBadge", { configurable: true, value: originalClear });
  });
});
