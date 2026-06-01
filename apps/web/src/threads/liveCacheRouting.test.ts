import { describe, expect, it } from "vitest";

import type { EventEnvelope, ThreadSummary } from "../api/client";
import { sidebarLiveCacheRoute } from "./liveCacheRouting";

describe("thread live cache routing", () => {
  it("ignores patches for threads that are not in sidebar caches", () => {
    expect(sidebarLiveCacheRoute(event({ kind: "thread_view.patch", threadId: "thread-1" }), null)).toEqual({
      kind: "ignore",
    });

    expect(sidebarLiveCacheRoute(event({ kind: "timeline.thread_metadata", threadId: "thread-1" }), null)).toEqual({
      kind: "ignore",
    });
  });

  it("invalidates a known list only while the thread still lacks a display title", () => {
    const untitled = threadSummary("thread-1", { name: "New thread", preview: null });
    const titled = threadSummary("thread-1", { name: "Ready", preview: "Ready" });

    expect(
      sidebarLiveCacheRoute(event({ kind: "thread_view.patch", threadId: "thread-1" }), {
        scope: "project",
        projectId: "project-1",
        thread: untitled,
      }),
    ).toEqual({
      kind: "invalidateKnownThreadList",
      location: { scope: "project", projectId: "project-1", thread: untitled },
      reason: "missingDisplayTitle",
    });

    expect(
      sidebarLiveCacheRoute(event({ kind: "thread_view.patch", threadId: "thread-1" }), {
        scope: "chat",
        thread: titled,
      }),
    ).toEqual({ kind: "ignore" });
  });
});

function event(overrides: Partial<EventEnvelope>): EventEnvelope {
  return {
    id: "event-1",
    seq: 10,
    kind: "gateway.warning",
    codexMethod: null,
    projectId: null,
    threadId: null,
    turnId: null,
    itemId: null,
    payload: {},
    receivedAt: "2026-05-02T00:00:00Z",
    ...overrides,
  };
}

function threadSummary(id: string, overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    createdAt: 1,
    cwd: "/workspace",
    gitInfo: null,
    id,
    lastCompletedAgentTurnSeq: null,
    name: "Live thread",
    notificationsEnabled: true,
    pinnedAt: null,
    preview: null,
    rawPayload: {},
    seenCompletedAgentTurnSeq: 0,
    source: null,
    status: "idle",
    unreadCompletedAgentTurn: false,
    updatedAt: 2,
    ...overrides,
  };
}
