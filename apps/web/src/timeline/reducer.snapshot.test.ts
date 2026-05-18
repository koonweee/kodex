import { describe, expect, it } from "vitest";

import type { EventEnvelope, ThreadViewResponse } from "../api/client";
import { applyLiveTimelineUpdate, applyTimelineSnapshot, createTimelineState } from "./reducer";

describe("timeline canonical snapshots and patches", () => {
  it("renders canonical snapshot items in gateway display order", () => {
    const state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 4,
      items: [
        timelineItem({ id: "projection-turn-1-agent-1", itemId: "agent-1", text: "Answer", displayOrder: 2 }),
        timelineItem({
          id: "projection-turn-1-user-1",
          itemId: "user-1",
          itemType: "userMessage",
          text: "Question",
          displayOrder: 1,
        }),
      ],
    }));

    expect(state.items.map((item) => item.text)).toEqual(["Question", "Answer"]);
    expect(state.items.map((item) => item.id)).toEqual(["projection-turn-1-user-1", "projection-turn-1-agent-1"]);
    expect(state.viewRevision).toBe(4);
  });

  it("applies canonical patches by revision and row id", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [timelineItem({ text: "Part" })],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 2,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [timelineItem({ text: "Partial answer", status: "running" })],
    }));

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "projection-turn-1-agent-1",
      text: "Partial answer",
      status: "running",
    });
    expect(state.activeTurnId).toBe("turn-1");
    expect(state.viewRevision).toBe(2);
  });

  it("ignores stale canonical patches", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 10,
      items: [timelineItem({ text: "Fresh" })],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 9,
      items: [timelineItem({ text: "Stale" })],
    }));

    expect(state.items[0].text).toBe("Fresh");
    expect(state.viewRevision).toBe(10);
  });

  it("replaces legacy row ids that point at the same app-server item id", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      items: [timelineItem({ id: "agent-1", itemId: "agent-1", text: "Initial" })],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 2,
      items: [timelineItem({ id: "projection-turn-1-agent-1", itemId: "agent-1", text: "Canonical" })],
    }));

    expect(state.items.map((item) => item.id)).toEqual(["projection-turn-1-agent-1"]);
    expect(state.items[0].text).toBe("Canonical");
  });

  it("does not replace a different turn row that reuses the same app-server item id", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      items: [timelineItem({ id: "projection-turn-1-agent-1", turnId: "turn-1", itemId: "agent-1", text: "First" })],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 2,
      activeTurnId: "turn-2",
      liveState: "streaming",
      items: [
        timelineItem({ id: "projection-turn-2-agent-1", turnId: "turn-2", itemId: "agent-1", text: "Second" }),
      ],
    }));

    expect(state.items.map((item) => item.id)).toEqual(["projection-turn-1-agent-1", "projection-turn-2-agent-1"]);
    expect(state.items.map((item) => item.text)).toEqual(["First", "Second"]);
  });

  it("projects turn metadata from the canonical timeline contract", () => {
    const state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 4,
      turns: [{ id: "turn-1", status: "completed", startedAt: 1, completedAt: 5 }],
      items: [timelineItem({ turnId: "turn-1", text: "Answer" })],
    }));

    expect(state.turns).toMatchObject([
      { turnId: "turn-1", status: "completed", startedAtMs: 1_000, completedAtMs: 5_000 },
    ]);
  });

  it("removes active-turn rows omitted from the canonical patch", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [
        timelineItem({ id: "projection-turn-1-user-1", itemId: "user-1", itemType: "userMessage", text: "Question", displayOrder: 1 }),
        timelineItem({ id: "projection-turn-1-agent-1", itemId: "agent-1", text: "Draft", displayOrder: 2 }),
      ],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 2,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [timelineItem({ id: "projection-turn-1-user-1", itemId: "user-1", itemType: "userMessage", text: "Question", displayOrder: 1 })],
    }));

    expect(state.items.map((item) => item.id)).toEqual(["projection-turn-1-user-1"]);
  });

  it("projects pending request summaries from snapshots and patches", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      items: [],
      pendingApprovalRequests: [pendingRequest("approval-1", "execCommandApproval")],
      pendingUserInputRequests: [],
    }));

    expect(state.pendingApprovalRequests.map((request) => request.id)).toEqual(["approval-1"]);

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 2,
      pendingApprovalRequests: [],
      pendingUserInputRequests: [pendingRequest("input-1", "toolRequestUserInput")],
    }));

    expect(state.pendingApprovalRequests).toEqual([]);
    expect(state.pendingUserInputRequests.map((request) => request.id)).toEqual(["input-1"]);
  });
});

function snapshot({
  viewRevision,
  activeTurnId = null,
  liveState = "idle",
  items,
  pendingApprovalRequests = [],
  pendingUserInputRequests = [],
  turns = [],
}: {
  viewRevision: number;
  activeTurnId?: string | null;
  liveState?: string;
  items: ReturnType<typeof timelineItem>[];
  pendingApprovalRequests?: ReturnType<typeof pendingRequest>[];
  pendingUserInputRequests?: ReturnType<typeof pendingRequest>[];
  turns?: Array<{ id: string; status: string; startedAt?: number | null; completedAt?: number | null }>;
}): ThreadViewResponse {
  return {
    thread: {
      id: "thread-1",
      name: "Thread",
      cwd: "/tmp",
      status: liveState === "idle" ? "idle" : "active",
      createdAt: 1,
      updatedAt: 1,
      source: null,
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      approvalPolicy: null,
      approvalsReviewer: null,
      sandbox: null,
      gitInfo: null,
      pinnedAt: null,
      preview: null,
      lastCompletedAgentTurnSeq: null,
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: false,
      rawPayload: {},
    },
    liveState,
    timeline: {
      viewRevision,
      activeTurnId,
      liveState,
      pendingApprovalRequests,
      pendingUserInputRequests,
      turns,
      items,
    },
  } as ThreadViewResponse;
}

function projectionPatchEvent(payload: {
  viewRevision: number;
  activeTurnId?: string | null;
  liveState?: string;
  items?: ReturnType<typeof timelineItem>[];
  pendingApprovalRequests?: ReturnType<typeof pendingRequest>[];
  pendingUserInputRequests?: ReturnType<typeof pendingRequest>[];
}): EventEnvelope {
  return {
    id: `patch-${payload.viewRevision}`,
    seq: payload.viewRevision,
    kind: "thread_view.patch",
    codexMethod: "thread_view/patch",
    threadId: "thread-1",
    turnId: payload.activeTurnId ?? null,
    itemId: null,
    projectId: null,
    payload: {
      threadId: "thread-1",
      activeTurnId: payload.activeTurnId ?? null,
      liveState: payload.liveState ?? "idle",
      viewRevision: payload.viewRevision,
      pendingApprovalRequests: payload.pendingApprovalRequests ?? [],
      pendingUserInputRequests: payload.pendingUserInputRequests ?? [],
      turns: [],
      items: payload.items ?? [],
    },
    receivedAt: "2026-05-17T00:00:00Z",
  };
}

function timelineItem({
  id = "projection-turn-1-agent-1",
  itemId = "agent-1",
  itemType = "agentMessage",
  text = "Answer",
  displayOrder = 1,
  status = "completed",
  turnId = "turn-1",
}: {
  id?: string;
  itemId?: string;
  itemType?: string;
  text?: string;
  displayOrder?: number;
  status?: string;
  turnId?: string;
} = {}) {
  const rawPayload =
    itemType === "userMessage"
      ? { id: itemId, type: itemType, text }
      : { id: itemId, type: itemType, phase: "final_answer", text };
  return {
    id,
    threadId: "thread-1",
    turnId,
    itemId,
    itemType,
    status,
    displayOrder,
    codexMethod: status === "completed" ? "item/completed" : "item/upsert",
    timestampMs: 1_779_000_000_000 + displayOrder,
    payload: {
      source: "appServerSnapshot",
      turnId,
      itemId,
      item: rawPayload,
      itemSnapshot: {
        id: itemId,
        itemType,
        text,
        rawPayload,
        skillMentions: [],
      },
    },
  };
}

function pendingRequest(id: string, method: string) {
  return {
    id,
    requestId: `request-${id}`,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    method,
    status: "pending",
    requestKind: method,
    title: method,
    summary: null,
    createdAt: "2026-05-17T00:00:00Z",
  };
}
