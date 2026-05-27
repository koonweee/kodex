import { describe, expect, it } from "vitest";

import type { ThreadSummary } from "../api/client";
import { unreadAgentMessageBadgeCount } from "./unreadAgentMessages";

function thread(id: string, unreadCompletedAgentTurn: boolean): ThreadSummary {
  return {
    id,
    name: id,
    cwd: "/workspace",
    status: "idle",
    createdAt: 1,
    updatedAt: 1,
    source: "local",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    approvalPolicy: null,
    approvalsReviewer: null,
    agentNickname: null,
    agentRole: null,
    sandbox: null,
    gitInfo: null,
    notificationsEnabled: true,
    pinnedAt: null,
    preview: null,
    lastCompletedAgentTurnSeq: unreadCompletedAgentTurn ? 1 : null,
    seenCompletedAgentTurnSeq: 0,
    unreadCompletedAgentTurn,
    rawPayload: {},
  };
}

describe("unread agent message notifications", () => {
  it("dedupes unread badge count across thread groups", () => {
    const unread = thread("thread-1", true);

    expect(unreadAgentMessageBadgeCount([[unread], [unread, thread("thread-2", false)]])).toBe(1);
  });
});
