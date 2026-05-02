import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../api/client";
import { completedAgentTurnEvent } from "./events";

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
