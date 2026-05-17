import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import {
  completedAgentTurnEvent,
  threadNameUpdateFromEvent,
  threadStatusUpdateFromEvent,
  threadUpsertFromEvent,
} from "./events";

describe("thread events", () => {
  it("ignores legacy raw completion notifications", () => {
    expect(
      completedAgentTurnEvent(
        event({
          kind: "codex.notification",
          codexMethod: "turn/completed",
          threadId: "thread-1",
          payload: { threadId: "thread-1" },
        }),
      ),
    ).toBeNull();
  });

  it("recognizes canonical idle projection patches as completed agent turns", () => {
    expect(
      completedAgentTurnEvent(
        event({
          kind: "timeline.projection_patch",
          codexMethod: "timeline/projection_patch",
          threadId: "thread-1",
          payload: { threadId: "thread-1", liveState: "idle", activeTurnId: null, items: [] },
        }),
      ),
    ).toEqual({ threadId: "thread-1", seq: 10 });

    expect(
      completedAgentTurnEvent(
        event({
          kind: "timeline.projection_patch",
          codexMethod: "timeline/projection_patch",
          threadId: "thread-1",
          payload: { threadId: "thread-1", liveState: "streaming", activeTurnId: "turn-1", items: [] },
        }),
      ),
    ).toBeNull();
  });

  it("recognizes running and idle status from canonical projection patches", () => {
    expect(
      threadStatusUpdateFromEvent(
        event({
          kind: "timeline.projection_patch",
          threadId: "thread-1",
          payload: { liveState: "streaming" },
        }),
      ),
    ).toEqual({ threadId: "thread-1", status: "active" });

    expect(
      threadStatusUpdateFromEvent(
        event({
          kind: "timeline.projection_patch",
          payload: { threadId: "thread-1", liveState: "idle", activeTurnId: null },
        }),
      ),
    ).toEqual({ threadId: "thread-1", status: "idle" });
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
    kind: "codex.notification",
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
    rawPayload: {},
    seenCompletedAgentTurnSeq: 0,
    status: "idle" as const,
    unreadCompletedAgentTurn: false,
    updatedAt: 2,
  };
}
