import { describe, expect, it } from "vitest";

import type { Approval, ThreadSummary } from "../api/client";
import { sortPinnedThreadsForSidebar, sortThreadsForSidebar, threadDisplayTitle, withoutPinnedThreads } from "./helpers";

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

  it("sorts pinned threads by attention first, then pin time and recency", () => {
    expect(
      sortPinnedThreadsForSidebar(
        [
          threadSummary("older-pin", { pinnedAt: "2026-05-05T00:00:00Z", updatedAt: 100 }),
          threadSummary("newer-pin", { pinnedAt: "2026-05-06T00:00:00Z", updatedAt: 10 }),
          threadSummary("active-pin", { pinnedAt: "2026-05-04T00:00:00Z", status: "active", updatedAt: 1 }),
          threadSummary("same-pin-recent", { pinnedAt: "2026-05-05T00:00:00Z", updatedAt: 200 }),
        ],
        [],
        new Set(),
      ).map((thread) => thread.id),
    ).toEqual(["active-pin", "newer-pin", "same-pin-recent", "older-pin"]);
  });

  it("filters pinned threads out of normal sidebar lists", () => {
    expect(
      withoutPinnedThreads([
        threadSummary("normal"),
        threadSummary("pinned", { pinnedAt: "2026-05-06T00:00:00Z" }),
      ]).map((thread) => thread.id),
    ).toEqual(["normal"]);
  });
});

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
