import { describe, expect, it } from "vitest";

import type { Approval, Project, ThreadSummary } from "../api/client";
import {
  sortPinnedThreadsForSidebar,
  sortProjectThreadsForSidebar,
  sortThreadsForSidebar,
  threadDisplayTitle,
  withPinnedProjectThreads,
  withoutPinnedThreads,
} from "./helpers";

function threadSummary(
  id: string,
  overrides: Partial<ThreadSummary> = {},
): ThreadSummary {
  return {
    createdAt: 1,
    cwd: "/tmp/kodex",
    id,
    name: id,
    notificationsEnabled: true,
    rawPayload: {},
    seenCompletedAgentTurnSeq: 0,
    status: "idle",
    unreadCompletedAgentTurn: false,
    updatedAt: 1,
    ...overrides,
  };
}

describe("sidebar thread ordering", () => {
  it("sorts by draft title, approval state, and recency without promoting active or unread threads", () => {
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
    ).toEqual(["draft", "approval", "recent", "unread", "older", "active"]);
  });

  it("sorts pinned threads by attention first, then pin time and recency without promoting active or unread threads", () => {
    expect(
      sortPinnedThreadsForSidebar(
        [
          threadSummary("older-pin", {
            pinnedAt: "2026-05-05T00:00:00Z",
            unreadCompletedAgentTurn: true,
            updatedAt: 100,
          }),
          threadSummary("newer-pin", { pinnedAt: "2026-05-06T00:00:00Z", updatedAt: 10 }),
          threadSummary("active-pin", { pinnedAt: "2026-05-04T00:00:00Z", status: "active", updatedAt: 1 }),
          threadSummary("same-pin-recent", { pinnedAt: "2026-05-05T00:00:00Z", updatedAt: 200 }),
        ],
        [],
        new Set(),
      ).map((thread) => thread.id),
    ).toEqual(["newer-pin", "same-pin-recent", "older-pin", "active-pin"]);
  });

  it("sorts project threads by pin time before attention and recency", () => {
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
      sortProjectThreadsForSidebar(
        [
          threadSummary("recent", { createdAt: 5, updatedAt: 50 }),
          threadSummary("approval", { createdAt: 4, updatedAt: 10 }),
          threadSummary("draft", { createdAt: 3, updatedAt: 40 }),
          threadSummary("older-pin", { createdAt: 2, pinnedAt: "2026-05-05T00:00:00Z", updatedAt: 1 }),
          threadSummary("newer-pin", { createdAt: 1, pinnedAt: "2026-05-06T00:00:00Z", updatedAt: 1 }),
        ],
        approvals,
        new Set(["draft"]),
      ).map((thread) => thread.id),
    ).toEqual(["newer-pin", "older-pin", "draft", "approval", "recent"]);
  });

  it("filters pinned threads out of normal sidebar lists", () => {
    expect(
      withoutPinnedThreads([
        threadSummary("normal"),
        threadSummary("pinned", { pinnedAt: "2026-05-06T00:00:00Z" }),
      ]).map((thread) => thread.id),
    ).toEqual(["normal"]);
  });

  it("merges pinned project threads into their owning project lists", () => {
    expect(
      withPinnedProjectThreads(
        {
          "project-1": [threadSummary("normal", { cwd: "/workspace/project-1" })],
        },
        [
          threadSummary("pinned-project", { cwd: "/workspace/project-1", pinnedAt: "2026-05-06T00:00:00Z" }),
          threadSummary("pinned-chat", { cwd: "/workspace/chats/2026-05-06", pinnedAt: "2026-05-06T00:01:00Z" }),
        ],
        [projectSummary("project-1", "Project", "/workspace/project-1")],
      )["project-1"].map((thread) => thread.id),
    ).toEqual(["pinned-project", "normal"]);
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

function projectSummary(id: string, name: string, cwd: string): Project {
  return {
    createdAt: "2026-05-01T00:00:00Z",
    cwd,
    id,
    name,
    updatedAt: "2026-05-01T00:00:00Z",
  };
}
