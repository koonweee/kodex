import { describe, expect, it } from "vitest";

import type { EventEnvelope, ThreadSummary } from "../api/client";
import { eventCanAffectSubagentDiscovery, sidebarLiveCacheRoute } from "./liveCacheRouting";

describe("thread live cache routing", () => {
  it("invalidates all thread lists only when a selected patch has no cached location", () => {
    expect(sidebarLiveCacheRoute(event({ kind: "thread_view.patch", threadId: "thread-1" }), null)).toEqual({
      kind: "invalidateAllThreadLists",
      reason: "missingThreadMetadata",
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

  it("detects subagent discovery changes from row-carried collab agent payloads only", () => {
    expect(
      eventCanAffectSubagentDiscovery(event({
        kind: "thread_view.patch",
        payload: {
          scope: "turn",
          upsertRows: [
            {
              id: "row-1",
              kind: "activity",
              items: [{ itemType: "collab_agent", payload: {} }],
            },
          ],
        },
      })),
    ).toBe(true);

    expect(
      eventCanAffectSubagentDiscovery(event({
        kind: "thread_view.patch",
        payload: {
          scope: "turn",
          items: [{ itemType: "collab_agent", payload: {} }],
        },
      })),
    ).toBe(false);
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
