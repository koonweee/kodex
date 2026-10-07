import { describe, expect, it } from "vitest";

import type {
  EventEnvelope,
  ThreadTimelineRow,
  ThreadTimelineSnapshotItem,
  ThreadViewPatch,
  ThreadViewResponse,
} from "../api/client";
import {
  applyLiveTimelineUpdate,
  applyTimelineSnapshot,
  createTimelineState,
} from "./reducer";

const first = canonicalItem("command-1", "commandExecution", 1, { command: "pwd", output: "/tmp" });
const second = canonicalItem("command-2", "commandExecution", 3, { command: "ls", output: "src" });
const third = canonicalItem("command-3", "commandExecution", 7, { command: "git status", output: "clean" });
const reasoning = canonicalItem("reasoning-1", "reasoning", 2, { summary: [], content: [] });
const bookkeeping = canonicalItem("subagent-1", "subAgentActivity", 4);
const hook = canonicalItem("hook-1", "hookPrompt", 5);
const emptyPlan = canonicalItem("plan-1", "plan", 6, { text: "" });
const hiddenRows = [reasoning, bookkeeping, hook, emptyPlan].map(itemRow);

// The gateway owns membership, including groups that span standalone hidden rows.
const groupedRows = [activityRow([first, second, third]), ...hiddenRows];

describe("canonical activity grouping", () => {
  it("keeps a single activity row across hidden diagnostics and updates its commands from canonical patches", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot(1, [
      ...hiddenRows.slice().reverse(),
      activityRow([first, second]),
    ]));

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      type: "activity",
      items: [{ command: "pwd" }, { command: "ls" }],
    });
    expect(state.hiddenItems.map((item) => item.id)).toEqual([
      reasoning.id, bookkeeping.id, hook.id, emptyPlan.id,
    ]);

    state = applyLiveTimelineUpdate(state, patch(2, [activityRow([first, second, third])]));

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      type: "activity",
      items: [
        { id: first.id, command: "pwd", output: "/tmp" },
        { id: second.id, command: "ls", output: "src" },
        { id: third.id, command: "git status", output: "clean" },
      ],
    });
    expect(state.hiddenItems).toHaveLength(4);
  });

  it("converges two clients after hidden reasoning becomes visible and later disappears", () => {
    const initial = snapshot(1, groupedRows);
    let liveClient = applyTimelineSnapshot(createTimelineState(), initial);
    let reconnectingClient = applyTimelineSnapshot(createTimelineState(), initial);
    const visibleReasoning = canonicalItem("reasoning-1", "reasoning", 2, {
      summary: ["Checking the repository before continuing."],
      content: [],
    });
    const splitRows = [
      activityRow([first]),
      itemRow(visibleReasoning),
      activityRow([second, third]),
      ...hiddenRows.slice(1),
    ];

    // One client receives the canonical live regrouping; the other misses it.
    liveClient = applyLiveTimelineUpdate(liveClient, patch(2, splitRows));
    expect(liveClient.rows.map((row) => row.type)).toEqual(["activity", "item", "activity"]);
    expect(liveClient.rows[1]).toMatchObject({
      type: "item",
      item: { id: reasoning.id, text: "Checking the repository before continuing." },
    });
    expect(liveClient.hiddenItems.map((item) => item.id)).not.toContain(reasoning.id);
    expect(reconnectingClient.rows).toHaveLength(1);

    reconnectingClient = applyTimelineSnapshot(reconnectingClient, snapshot(2, splitRows.slice().reverse()));
    expect(reconnectingClient.rows).toEqual(liveClient.rows);
    expect(reconnectingClient.hiddenItems).toEqual(liveClient.hiddenItems);

    // Merging removes a group, so the gateway replaces the complete affected turn.
    liveClient = applyLiveTimelineUpdate(liveClient, patch(3, groupedRows, "turn"));
    reconnectingClient = applyTimelineSnapshot(reconnectingClient, snapshot(3, groupedRows));

    expect(liveClient.rows).toHaveLength(1);
    expect(liveClient.rows[0]).toMatchObject({ type: "activity", items: [{ id: first.id }, { id: second.id }, { id: third.id }] });
    expect(reconnectingClient.rows).toEqual(liveClient.rows);
    expect(reconnectingClient.hiddenItems.map((item) => item.id).sort()).toEqual(
      liveClient.hiddenItems.map((item) => item.id).sort(),
    );
  });
});

function canonicalItem(
  itemId: string,
  itemType: string,
  displayOrder: number,
  fields: Partial<ThreadTimelineSnapshotItem["payload"]["item"]> = {},
): ThreadTimelineSnapshotItem {
  return {
    id: `projection-turn-1-${itemId}`,
    itemId,
    itemType,
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    displayOrder,
    codexMethod: "item/completed",
    timestampMs: null,
    payload: {
      source: "appServerSnapshot",
      turnId: "turn-1",
      itemId,
      item: { id: itemId, type: itemType, ...fields },
      itemSnapshot: { id: itemId, itemType },
    },
  };
}

function itemRow(item: ThreadTimelineSnapshotItem): ThreadTimelineRow {
  return {
    id: `item-${item.id}`,
    kind: item.itemType,
    turnId: item.turnId,
    displayOrder: item.displayOrder,
    status: item.status,
    item,
    items: [],
    fileChanges: [],
    collapsedRows: [],
  };
}

function activityRow(items: ThreadTimelineSnapshotItem[]): ThreadTimelineRow {
  return {
    ...itemRow(items[0]),
    id: `activity-${items[0].id}`,
    kind: "activity",
    item: null,
    items,
  };
}

function snapshot(viewRevision: number, rows: ThreadTimelineRow[]): ThreadViewResponse {
  return {
    thread: {
      id: "thread-1", cwd: "/tmp", status: "active", createdAt: 1, updatedAt: 1,
      parentThreadId: null, canAcceptDirectInput: null, notificationsEnabled: true,
      pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null,
      readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false,
    },
    liveState: "streaming",
    timeline: {
      viewRevision, rows, activeTurnId: "turn-1", liveState: "streaming",
      pendingApprovalRequests: [], pendingUserInputRequests: [],
      turns: [{ id: "turn-1", status: "inProgress" }],
    },
  };
}

function patch(
  viewRevision: number,
  rows: ThreadTimelineRow[],
  scope: ThreadViewPatch["scope"] = "row_delta",
): EventEnvelope {
  const payload: ThreadViewPatch = {
    threadId: "thread-1", scope, affectedTurnIds: ["turn-1"],
    viewRevision, rows, activeTurnId: "turn-1", liveState: "streaming",
    pendingApprovalRequests: [], pendingUserInputRequests: [],
  };
  return {
    id: `patch-${viewRevision}`, seq: viewRevision, kind: "thread_view.patch",
    codexMethod: "thread_view/patch", threadId: "thread-1", turnId: "turn-1",
    itemId: null, projectId: null, payload, receivedAt: "2026-10-07T00:00:00Z",
  };
}
