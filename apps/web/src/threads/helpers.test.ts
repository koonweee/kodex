import { describe, expect, it } from "vitest";

import type { ThreadSummary } from "../api/client";
import { threadDisplayTitle } from "./helpers";

function threadSummary(
  id: string,
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    parentThreadId: null, canAcceptDirectInput: null,
    createdAt: 1,
    cwd: "/tmp/kodex",
    id,
    name: id,
    notificationsEnabled: true,
    rawPayload: {},
    latestCompletedTurnId: null,
    seenCompletedTurnId: null,
    readRevision: 0,
    readStateKnown: false,
    status: "idle",
    unreadCompletedAgentTurn: false,
    updatedAt: 1,
    ...overrides,
  };
}

describe("thread display titles", () => {
  it("uses New thread when a thread has no generated title or preview yet", () => {
    expect(
      threadDisplayTitle(
        threadSummary("019de25f-9ac3-72b1-adf6-a108f82d1fb6", {
          name: "New thread",
          preview: null,
        }),
      ),
    ).toBe("New thread");
  });
});
