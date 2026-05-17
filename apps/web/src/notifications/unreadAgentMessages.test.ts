import { describe, expect, it } from "vitest";

import type { ThreadSummary } from "../api/client";
import { unreadAgentMessageBadgeCount, unreadAgentMessageIntent } from "./unreadAgentMessages";

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

  it("builds a minimal unread notification intent", () => {
    expect(unreadAgentMessageIntent(thread("thread-1", true), 2)).toMatchObject({
      badgeCount: 2,
      body: "Agent has a new message.",
      kind: "unreadAgentMessage",
      route: "/threads/thread-1",
      tag: "kodex-unread-agent-message:thread-1",
      title: "thread-1",
    });
  });

  it("truncates long thread titles in notification intents", () => {
    expect(
      unreadAgentMessageIntent(
        {
          ...thread("thread-1", true),
          name: "Octopus Heart Facts With An Overly Long Thread Title That Should Not Fill The Banner",
        },
        1,
      ).title,
    ).toBe("Octopus Heart Facts With An Overly Long Thread T...");
  });
});
