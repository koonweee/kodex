import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import {
  threadReadUpdateFromEvent,
  threadNotificationsUpdateFromEvent,
  threadNameUpdateFromEvent,
  threadStatusUpdateFromEvent,
  threadUpsertFromEvent,
} from "./events";

describe("thread events", () => {
  it("does not interpret idle, reset or raw completion notifications as read state", () => {
    for (const kind of ["thread_view.patch", "thread_view.cursor", "timeline.turn_completed"]) {
      expect(threadReadUpdateFromEvent(event({ kind, threadId: "thread-1", payload: {
        scope: "full_snapshot", activeTurnId: null, liveState: "idle", sourceMethod: "turn/completed",
      } }))).toBeNull();
    }
  });

  it("accepts the full revisioned native read tuple, including an unknown cleared head", () => {
    const read = { threadId: "thread-1", updatedAt: "2026-10-05T00:00:00Z", latestCompletedTurnId: null,
      seenCompletedTurnId: "earlier", readRevision: 42, readStateKnown: false, unreadCompletedAgentTurn: false };
    expect(threadReadUpdateFromEvent(event({ kind: "thread.read_updated", payload: read }))).toEqual(read);
    expect(threadReadUpdateFromEvent(event({ kind: "thread.read_updated", payload: { ...read, readRevision: undefined } }))).toBeNull();
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

  it("prefers exact native thread status carried by canonical projection patches", () => {
    expect(
      threadStatusUpdateFromEvent(
        event({
          kind: "thread_view.patch",
          threadId: "thread-1",
          payload: {
            scope: "lifecycle",
            liveState: "idle",
            threadStatus: "systemError",
          },
        }),
      ),
    ).toEqual({ threadId: "thread-1", status: "systemError", updatedAt: 1_777_680_000 });

    expect(
      threadStatusUpdateFromEvent(
        event({
          kind: "thread_view.patch",
          payload: {
            scope: "lifecycle",
            threadId: "thread-2",
            liveState: "notLoaded",
            threadStatus: "notLoaded",
          },
        }),
      ),
    ).toEqual({ threadId: "thread-2", status: "notLoaded", updatedAt: 1_777_680_000 });
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
    expect(threadNotificationsUpdateFromEvent(event({ kind: "thread.sections_updated" }))).toBeNull();
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
    expect(threadUpsertFromEvent(event({ kind: "thread.sections_updated" }))).toBeNull();
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
    latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: true,
    status: "idle" as const,
    unreadCompletedAgentTurn: false,
    updatedAt: 2,
  };
}
