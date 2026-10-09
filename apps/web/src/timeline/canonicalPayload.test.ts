import { describe, expect, it } from "vitest";

import type { EventEnvelope, ThreadViewResponse } from "../api/client";
import {
  addOptimisticUserMessage,
  applyTimelineSnapshot,
  applyLiveTimelineUpdate,
  canApplyThreadViewItemDelta,
  createTimelineState,
} from "./reducer";

const attachment = {
  id: "file-1", fileName: "notes.md", extension: "md",
  relativePath: "notes.md", sizeBytes: 12,
};
const mention = { start: 0, end: 7, name: "review", path: "/skills/review/SKILL.md" };

function snapshot(rows: unknown[]): ThreadViewResponse {
  return {
    thread: {
      id: "thread-1", parentThreadId: null, canAcceptDirectInput: null,
      cwd: "/tmp", status: "idle", createdAt: 0, updatedAt: 0,
      notificationsEnabled: true, pinned: false, latestCompletedTurnId: null,
      seenCompletedTurnId: null, readRevision: 0, readStateKnown: false,
      unreadCompletedAgentTurn: false,
    },
    liveState: "idle",
    timeline: {
      viewRevision: 4, activeTurnId: null, liveState: "idle",
      pendingApprovalRequests: [], pendingUserInputRequests: [], turns: [], rows,
    },
  } as ThreadViewResponse;
}

function item(itemType: string, payload: unknown) {
  return {
    id: "projection-user-1", itemId: "native-user-1", threadId: "thread-1",
    turnId: "turn-1", itemType, status: "completed", displayOrder: 1,
    timestampMs: 1779000000000, payload,
  };
}

describe("compact canonical payloads", () => {
  it("preserves user identity, images, skills and attachments without repeated envelope fields", () => {
    const pending = addOptimisticUserMessage(createTimelineState(), {
      threadId: "thread-1", clientRequestId: "client-1", text: "$review notes",
    });
    const state = applyTimelineSnapshot(pending, snapshot([{
      id: "row-user-1", kind: "user_message", turnId: "turn-1", displayOrder: 1,
      status: "completed",
      item: item("userMessage", {
        clientId: "client-1", skillMentions: [mention], fileAttachments: [attachment],
        item: { content: [
          { type: "text", text: "$review notes" },
          { type: "localImage", path: "/tmp/photo.png" },
        ] },
      }),
    }]));

    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({
      id: "projection-user-1", serverItemId: "native-user-1", clientId: "client-1",
      kind: "user_message", status: "completed", text: "$review notes",
      timestampMs: 1779000000000, skillMentions: [mention], fileAttachments: [attachment],
      images: [{ path: "/tmp/photo.png" }],
    });
    expect(state.items.some(entry => entry.source === "optimistic")).toBe(false);
    expect(state.viewRevision).toBe(4);
  });

  it("renders activity rows and empty work disclosures when unused collections are omitted", () => {
    const state = applyTimelineSnapshot(createTimelineState(), snapshot([
      {
        id: "activity-1", kind: "activity", turnId: "turn-1", displayOrder: 1,
        status: "completed", items: [item("commandExecution", {
          item: { command: "pwd", cwd: "/tmp", output: "/tmp" },
        })],
      },
      {
        id: "work-2", kind: "work", turnId: "turn-2", displayOrder: 2,
        status: "completed", work: { state: "completed", startedAt: 100, completedAt: 101 },
      },
    ]));
    expect(state.rows).toHaveLength(2);
    expect(state.rows[0]).toMatchObject({
      type: "activity", items: [{ kind: "command_execution", command: "pwd", output: "/tmp" }],
    });
    expect(state.rows[1]).toMatchObject({
      type: "work", collapsedRows: [], startedAtMs: 100000, completedAtMs: 101000,
    });
  });

  it("uses canonical status before classifying empty assistant messages", () => {
    const state = applyTimelineSnapshot(createTimelineState(), snapshot([{
      id: "row-empty", kind: "assistant_message", turnId: "turn-1", displayOrder: 1,
      status: "completed", item: item("agentMessage", { item: { text: "", phase: "final_answer" } }),
    }]));
    expect(state.rows).toEqual([]);
    expect(state.hiddenItems).toHaveLength(1);
  });
  it("retains an empty diagnostic marker as a canonical base for a later row update", () => {
    const state = applyTimelineSnapshot(createTimelineState(), snapshot([{
      id: "row-hook", kind: "hidden", turnId: "turn-1", displayOrder: 1,
      status: "completed", item: item("hookPrompt", { item: {} }),
    }]));
    expect(state.rows).toEqual([]);
    expect(state.hiddenItems).toMatchObject([{ id: "projection-user-1", debugEvents: [], text: "" }]);
    const event: EventEnvelope = {
      id: "update-5", seq: 5, threadId: "thread-1", kind: "thread_view.patch",
      receivedAt: "2026-10-08T00:00:00Z",
      payload: {
        scope: "row_delta", threadId: "thread-1", viewRevision: 5,
        activeTurnId: "turn-1", liveState: "streaming", affectedTurnIds: ["turn-1"],
        pendingApprovalRequests: [], pendingUserInputRequests: [], turns: [],
        rows: [{
          id: "row-answer", kind: "assistant_message", turnId: "turn-1", displayOrder: 2,
          status: "running", item: {
            ...item("agentMessage", { item: { text: "Working" } }),
            id: "projection-answer", itemId: "native-answer", status: "running", displayOrder: 2,
          },
        }],
      },
    };
    expect(canApplyThreadViewItemDelta(state, event)).toBe(true);
    const updated = applyLiveTimelineUpdate(state, event);
    expect(updated.items).toMatchObject([{ id: "projection-answer", text: "Working", status: "running" }]);
    expect(updated.viewRevision).toBe(5);
    expect(updated.activeTurnId).toBe("turn-1");
  });

});
