import { describe, expect, it } from "vitest";

import type { EventEnvelope, ThreadTimelineRow, ThreadViewResponse } from "../api/client";
import {
  addOptimisticUserMessage,
  applyLiveTimelineUpdate,
  applyTimelineHistoryWindow,
  applyTimelineSnapshot,
  createTimelineState,
  markOptimisticUserMessageSent,
  removeOptimisticUserMessage,
  type TimelineState,
} from "./reducer";

type Projection = "snapshot" | "full_snapshot" | "turn" | "row_delta";

function userRow(itemId: string, clientId?: string | null, text = "Identical message"): ThreadTimelineRow {
  return {
    id: `row-${itemId}`, kind: "user_message", status: "completed", turnId: "turn-1", displayOrder: 1,
    item: {
      id: itemId, itemId, itemType: "userMessage", threadId: "thread-1", turnId: "turn-1", status: "completed", displayOrder: 1, codexMethod: "item/completed",
      payload: {
        source: "appServerSnapshot", turnId: "turn-1", itemId,
        item: { id: itemId, type: "userMessage", clientId, content: [{ type: "text", text }] },
        itemSnapshot: { id: itemId, itemType: "userMessage", clientId },
      },
    },
    items: [], collapsedRows: [], fileChanges: [],
  };
}

function snapshot(rows: ThreadTimelineRow[], revision: number): ThreadViewResponse {
  return {
    thread: {
      id: "thread-1", parentThreadId: null, canAcceptDirectInput: null, cwd: "/workspace", status: "idle", createdAt: 0, updatedAt: 0,
      notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false,
    },
    liveState: "idle",
    timeline: { viewRevision: revision, liveState: "idle", rows, turns: [], pendingApprovalRequests: [], pendingUserInputRequests: [] },
  };
}

function project(projection: Projection, state: TimelineState, rows: ThreadTimelineRow[], revision: number) {
  const view = snapshot(rows, revision);
  if (projection === "snapshot") return applyTimelineSnapshot(state, view);
  const event: EventEnvelope = {
    id: String(revision), seq: revision, kind: "thread_view.patch", threadId: "thread-1", receivedAt: "2026-10-05T00:00:00Z",
    payload: { ...view.timeline, scope: projection, threadId: "thread-1", affectedTurnIds: ["turn-1"] },
  };
  return applyLiveTimelineUpdate(state, event);
}

function submit(state: TimelineState, id: string) {
  return addOptimisticUserMessage(state, { clientRequestId: id, text: "Identical message", threadId: "thread-1" });
}

function pendingIds(state: TimelineState) {
  return state.items.filter((item) => item.source === "optimistic").map((item) => item.id).sort();
}

describe("native client message identity", () => {
  it.each<Projection>(["snapshot", "full_snapshot", "turn"])("replaces queued Steer canonical pending identity with its native receipt through %s", (projection) => {
    const existingNative = userRow("existing-native", "original-queue-correlation");
    const pending = userRow("pending-user-fresh-transfer", "fresh-transfer");
    pending.status = "running";
    pending.item = { ...pending.item!, status: "running" };
    let first = project("turn", createTimelineState(), [existingNative, pending], 1);
    let missedReceipt = first;
    expect(first.items.map((item) => item.id).sort()).toEqual(["existing-native", "pending-user-fresh-transfer"]);
    expect(first.items.every((item) => item.source === "app_server")).toBe(true);

    const receipt = userRow("native-steered-receipt", "fresh-transfer");
    first = project(projection, first, [existingNative, receipt], 2);
    // Equal text cannot prove replacement: only the exact native receipt ID may
    // remain, while the unrelated native message keeps its separate identity.
    expect(first.items.map((item) => item.id).sort()).toEqual(["existing-native", "native-steered-receipt"]);
    expect(first.items.find((item) => item.id === "native-steered-receipt")).toMatchObject({ clientId: "fresh-transfer", status: "completed", source: "app_server" });
    missedReceipt = project("snapshot", missedReceipt, [existingNative, receipt], 3);
    expect(missedReceipt.items.map((item) => item.id).sort()).toEqual(["existing-native", "native-steered-receipt"]);
  });

  it.each<Projection>(["snapshot", "full_snapshot", "turn", "row_delta"])("matches only the exact native client ID through %s", (projection) => {
    const foreign = userRow("from-other-tab", "other-tab");
    let state = submit(submit(applyTimelineSnapshot(createTimelineState(), snapshot([foreign], 0)), "first"), "second");
    state = project(projection, state, [foreign], 1);
    expect(pendingIds(state)).toEqual(["optimistic-user-first", "optimistic-user-second"]);

    const second = userRow("native-second", "second");
    state = project(projection, state, [foreign, second], 2);
    expect(pendingIds(state)).toEqual(["optimistic-user-first"]);
    expect(state.items.find((item) => item.id === "native-second")).toMatchObject({ clientId: "second", source: "app_server" });

    const first = userRow("native-first", "first", "Native text differs from the submitted display");
    state = project(projection, state, [foreign, second, first], 3);
    expect(pendingIds(state)).toEqual([]);
    expect(state.items.map((item) => item.id).sort()).toEqual(["from-other-tab", "native-first", "native-second"]);
  });

  it.each([undefined, null, ""])("does not guess from text when a legacy canonical message has client ID %s", (clientId) => {
    const state = project("full_snapshot", submit(createTimelineState(), "local"), [userRow("legacy-native", clientId)], 1);
    expect(pendingIds(state)).toEqual(["optimistic-user-local"]);
    expect(state.items.map((item) => item.text)).toEqual(["Identical message", "Identical message"]);
  });

  it("keeps two clients' identical pending text independent until each native identity arrives", () => {
    let first = submit(createTimelineState(), "client-a");
    let second = submit(createTimelineState(), "client-b");
    const fromSecond = userRow("native-b", "client-b");
    first = project("full_snapshot", first, [fromSecond], 1);
    second = project("full_snapshot", second, [fromSecond], 1);
    expect(pendingIds(first)).toEqual(["optimistic-user-client-a"]);
    expect(pendingIds(second)).toEqual([]);
    const fromFirst = userRow("native-a", "client-a");
    first = project("snapshot", first, [fromSecond, fromFirst], 2);
    second = project("snapshot", second, [fromSecond, fromFirst], 2);
    expect(first.items).toEqual(second.items);
    expect(pendingIds(first)).toEqual([]);
  });

  it("matches native IDs on older history pages without consuming unrelated local requests", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot([], 5));
    state = submit(submit(state, "local-a"), "local-b");
    state = applyTimelineHistoryWindow(state, snapshot([userRow("native-b", "local-b")], 3));
    expect(pendingIds(state)).toEqual(["optimistic-user-local-a"]);
    expect(state.items.find((item) => item.id === "native-b")).toMatchObject({ clientId: "local-b" });
    expect(state.viewRevision).toBe(5);
  });

  it("keeps an acknowledged optimistic message until its canonical replacement arrives", () => {
    const previous = userRow("previous-native", "previous", "Earlier message");
    let state = submit(project("snapshot", createTimelineState(), [previous], 1), "request");
    const keysBeforeAck = state.rows.map(row => row.key);
    state = markOptimisticUserMessageSent(state, "request");
    expect(state.rows.map(row => row.key)).toEqual(keysBeforeAck);
    expect(state.items.find(item => item.clientId === "request")).toMatchObject({ confirmationState: "sent", text: "Identical message" });
    state = project("turn", state, [previous], 2);
    expect(state.items.map(item => item.text)).toEqual(["Earlier message", "Identical message"]);
    const receipt = userRow("native-receipt", "request");
    receipt.displayOrder = 2;
    state = project("turn", state, [previous, receipt], 3);
    expect(state.items.map(item => item.id)).toEqual(["previous-native", "native-receipt"]);
    expect(pendingIds(state)).toEqual([]);
  });

  it("lets an authoritative full snapshot discard acknowledged input absent from native history", () => {
    const state = markOptimisticUserMessageSent(submit(createTimelineState(), "reverted"), "reverted");
    expect(project("full_snapshot", state, [], 2).items).toEqual([]);
  });

  it("preserves canonical rows when the matching HTTP acknowledgement or failure arrives later", () => {
    const state = project("full_snapshot", submit(createTimelineState(), "request"), [userRow("optimistic-user-request", "request")], 1);
    expect(markOptimisticUserMessageSent(state, "request").items.map((item) => item.source)).toEqual(["app_server"]);
    expect(removeOptimisticUserMessage(state, "request").items.map((item) => item.source)).toEqual(["app_server"]);
  });
});
