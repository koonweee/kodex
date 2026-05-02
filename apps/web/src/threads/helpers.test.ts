import { describe, expect, it } from "vitest";

import type { Approval, ThreadSummary } from "../api/client";
import { sortThreadsForSidebar } from "./helpers";

function threadSummary(
  id: string,
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    createdAt: 1,
    cwd: "/tmp/kodex",
    id,
    name: id,
    rawPayload: {},
    seenCompletedAgentTurnSeq: 0,
    status: "idle",
    unreadCompletedAgentTurn: false,
    updatedAt: 1,
    ...overrides,
  };
}

describe("sidebar thread ordering", () => {
  it("sorts by draft title, active state, approval, unread state, and recency", () => {
    const approvals: Approval[] = [
      {
        createdAt: "2026-05-01T00:00:00Z",
        id: "approval-1",
        method: "command_execution",
        payload: {},
        requestId: "request-1",
        status: "pending",
        threadId: "approval",
      },
    ];

    expect(
      sortThreadsForSidebar(
        [
          threadSummary("older", { createdAt: 5, updatedAt: 10 }),
          threadSummary("recent", { createdAt: 4, updatedAt: 50 }),
          threadSummary("unread", { createdAt: 3, updatedAt: 20, unreadCompletedAgentTurn: true }),
          threadSummary("approval", { createdAt: 2, updatedAt: 15 }),
          threadSummary("active", { createdAt: 1, status: "active", updatedAt: 1 }),
          threadSummary("draft", { createdAt: 6, updatedAt: 5 }),
        ],
        approvals,
        new Set(["draft"]),
      ).map((thread) => thread.id),
    ).toEqual(["draft", "active", "approval", "unread", "recent", "older"]);
  });
});
