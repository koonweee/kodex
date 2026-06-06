import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { markThreadSeen, type EventEnvelope } from "../api/client";
import { useThreadReadState } from "./useThreadReadState";

vi.mock("../api/client", async (importActual) => {
  const actual = await importActual<typeof import("../api/client")>();
  return {
    ...actual,
    markThreadSeen: vi.fn(async (threadId: string) => ({
      lastCompletedAgentTurnSeq: 1,
      seenCompletedAgentTurnSeq: 1,
      threadId,
      unreadCompletedAgentTurn: false,
    })),
  };
});

describe("useThreadReadState", () => {
  it("marks completed turns seen for visible non-selected threads", async () => {
    const updateThreadEverywhere = vi.fn();
    const { result } = renderHook(() =>
      useThreadReadState({
        chatThreads: [],
        onError: vi.fn(),
        pinnedThreads: [],
        selectedThreadIdRef: { current: "thread-1" },
        threadsByProjectId: {},
        updateThreadEverywhere,
        viewedThreadIdsRef: { current: new Set(["thread-2"]) },
      }),
    );

    result.current.applyCompletedAgentTurnEvent(completedThreadViewPatch("thread-2"));

    await waitFor(() => {
      expect(markThreadSeen).toHaveBeenCalledWith("thread-2", undefined);
    });
    const patcher = updateThreadEverywhere.mock.calls.at(-1)?.[1];
    expect(typeof patcher).toBe("function");
    expect(
      patcher?.({
        id: "thread-2",
        lastCompletedAgentTurnSeq: 1,
        seenCompletedAgentTurnSeq: 0,
        unreadCompletedAgentTurn: true,
      }),
    ).toMatchObject({
      seenCompletedAgentTurnSeq: 1,
      unreadCompletedAgentTurn: false,
    });
  });
});

function completedThreadViewPatch(threadId: string): EventEnvelope {
  return {
    codexMethod: null,
    id: "event-1",
    kind: "thread_view.patch",
    payload: {
      activeTurnId: null,
      liveState: "idle",
      threadId,
    },
    projectId: null,
    receivedAt: new Date(0).toISOString(),
    seq: 1,
    threadId,
  };
}
