import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import { completedAgentTurnEvent, threadStatusUpdateFromEvent } from "./events";

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

  it("recognizes normalized terminal turn upserts", () => {
    expect(
      completedAgentTurnEvent(
        event({
          kind: "timeline.turn_upsert",
          codexMethod: "turn/upsert",
          threadId: "thread-1",
          payload: { turn: { id: "turn-1", status: "completed" } },
        }),
      ),
    ).toEqual({ threadId: "thread-1", seq: 10 });
  });

  it("recognizes running and terminal thread status updates", () => {
    expect(
      threadStatusUpdateFromEvent(
        event({
          kind: "timeline.thread_status",
          threadId: "thread-1",
          payload: { status: "running" },
        }),
      ),
    ).toEqual({ threadId: "thread-1", status: "active" });

    expect(
      threadStatusUpdateFromEvent(
        event({
          kind: "timeline.turn_upsert",
          payload: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
        }),
      ),
    ).toEqual({ threadId: "thread-1", status: "idle" });
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
