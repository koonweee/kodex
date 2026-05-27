import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import {
  completedAgentTurnEvent,
  threadNotificationsUpdateFromEvent,
  threadNameUpdateFromEvent,
  threadStatusUpdateFromEvent,
  threadUpsertFromEvent,
} from "./events";

describe("thread events", () => {
  it("ignores non-canonical completion-shaped events", () => {
    expect(
      completedAgentTurnEvent(
        event({
          kind: "thread_view.cursor",
          codexMethod: "thread_view/cursor",
          threadId: "thread-1",
          payload: { threadId: "thread-1", sourceMethod: "turn/completed" },
        }),
      ),
    ).toBeNull();
  });

  it("recognizes canonical idle projection patches as completed agent turns", () => {
    expect(
      completedAgentTurnEvent(
        event({
          kind: "thread_view.patch",
          codexMethod: "thread_view/patch",
          threadId: "thread-1",
          payload: { scope: "lifecycle", threadId: "thread-1", liveState: "idle", activeTurnId: null, items: [] },
        }),
      ),
    ).toEqual({ threadId: "thread-1", seq: 10 });

    expect(
      completedAgentTurnEvent(
        event({
          kind: "thread_view.patch",
          codexMethod: "thread_view/patch",
          threadId: "thread-1",
          payload: { scope: "lifecycle", threadId: "thread-1", liveState: "streaming", activeTurnId: "turn-1", items: [] },
        }),
      ),
    ).toBeNull();
  });

  it("recognizes running and idle status from canonical projection patches", () => {
    expect(
      threadStatusUpdateFromEvent(
        event({
          kind: "thread_view.patch",
          threadId: "thread-1",
          payload: { scope: "lifecycle", liveState: "streaming" },
        }),
      ),
    ).toEqual({ threadId: "thread-1", status: "active", updatedAt: null });

    expect(
      threadStatusUpdateFromEvent(
        event({
          kind: "thread_view.patch",
          payload: { scope: "lifecycle", threadId: "thread-1", liveState: "idle", activeTurnId: null },
        }),
      ),
    ).toEqual({ threadId: "thread-1", status: "idle", updatedAt: 1_777_680_000 });
  });

  it("parses current and legacy thread name update notifications", () => {
    expect(
      threadNameUpdateFromEvent(
        event({
          codexMethod: "thread/name/updated",
          threadId: "thread-1",
          payload: { threadName: "Renamed thread" },
        }),
      ),
    ).toEqual({ threadId: "thread-1", name: "Renamed thread" });

    expect(
      threadNameUpdateFromEvent(
        event({
          codexMethod: "thread/nameUpdated",
          payload: { thread_id: "thread-2", thread_name: "Legacy title" },
        }),
      ),
    ).toEqual({ threadId: "thread-2", name: "Legacy title" });
  });

  it("keeps null thread name updates explicit", () => {
    expect(
      threadNameUpdateFromEvent(
        event({
          codexMethod: "thread/name/updated",
          threadId: "thread-1",
          payload: { threadName: null },
        }),
      ),
    ).toEqual({ threadId: "thread-1", name: null });
  });

  it("parses project and chat thread upsert events", () => {
    const summary = threadSummary("thread-live");

    expect(
      threadUpsertFromEvent(
        event({
          kind: "thread.upserted",
          projectId: "project-1",
          threadId: "thread-live",
          payload: { scope: "project", projectId: "project-1", thread: summary },
        }),
      ),
    ).toEqual({ scope: "project", projectId: "project-1", thread: summary });

    expect(
      threadUpsertFromEvent(
        event({
          kind: "thread.upserted",
          threadId: "thread-live",
          payload: { scope: "chat", projectId: null, thread: summary },
        }),
      ),
    ).toEqual({ scope: "chat", thread: summary });
  });

  it("parses notification setting update events", () => {
    expect(
      threadNotificationsUpdateFromEvent(
        event({
          kind: "thread.notifications_updated",
          threadId: "thread-1",
          payload: {
            threadId: "thread-1",
            notificationsEnabled: false,
            updatedAt: "2026-05-25T00:00:00Z",
          },
        }),
      ),
    ).toEqual({
      threadId: "thread-1",
      notificationsEnabled: false,
      updatedAt: "2026-05-25T00:00:00Z",
    });

    expect(
      threadNotificationsUpdateFromEvent(
        event({
          kind: "thread.notifications_updated",
          payload: {
            thread_id: "thread-2",
            notifications_enabled: true,
            updated_at: "2026-05-25T00:00:01Z",
          },
        }),
      ),
    ).toEqual({
      threadId: "thread-2",
      notificationsEnabled: true,
      updatedAt: "2026-05-25T00:00:01Z",
    });
  });

  it("rejects malformed notification setting update events", () => {
    expect(threadNotificationsUpdateFromEvent(event({ kind: "thread.pin_updated" }))).toBeNull();
    expect(
      threadNotificationsUpdateFromEvent(
        event({
          kind: "thread.notifications_updated",
          payload: { threadId: "thread-1", updatedAt: "2026-05-25T00:00:00Z" },
        }),
      ),
    ).toBeNull();
  });

  it("rejects malformed thread upsert events", () => {
    expect(threadUpsertFromEvent(event({ kind: "thread.pin_updated" }))).toBeNull();
    expect(
      threadUpsertFromEvent(
        event({
          kind: "thread.upserted",
          payload: { scope: "project", thread: threadSummary("thread-live") },
        }),
      ),
    ).toBeNull();
    expect(
      threadUpsertFromEvent(
        event({
          kind: "thread.upserted",
          payload: { scope: "chat", thread: { id: "thread-live" } },
        }),
      ),
    ).toBeNull();
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

function threadSummary(id: string) {
  return {
    createdAt: 1,
    cwd: "/workspace",
    id,
    name: "Live thread",
    notificationsEnabled: true,
    rawPayload: {},
    seenCompletedAgentTurnSeq: 0,
    status: "idle" as const,
    unreadCompletedAgentTurn: false,
    updatedAt: 2,
  };
}
