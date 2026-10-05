import { describe, expect, it } from "vitest";
import { asyncQuestions } from "./asyncQuestions";

describe("native async questions", () => {
  it("reads structured questions without parsing fallback Markdown", () => {
    expect(asyncQuestions({ item: { delivery: "async", questions: [{ title: "Choose **one**", options: ["A", "B"] }, { title: "Anything else?", options: null }] } })).toEqual([
      { title: "Choose **one**", options: ["A", "B"] }, { title: "Anything else?", options: [] },
    ]);
  });
  it("leaves ordinary and malformed messages on the Markdown fallback", () => {
    for (const item of [
      { text: "Question\n- A" }, { delivery: "normal", questions: [{ title: "Question" }] },
      { delivery: "async", questions: [{ title: "" }] },
      { delivery: "async", questions: [{ title: "Question", options: [42] }] },
    ]) expect(asyncQuestions({ item })).toEqual([]);
  });
});

it("retains normalized questions through canonical row compaction and later text deltas", async () => {
  const { applyLiveTimelineUpdate, createTimelineState } = await import("./reducer");
  const questions = [{ title: "Choose **one**", options: ["A", "B"] }];
  const event = {
    id: "patch", seq: 1, kind: "thread_view.patch", codexMethod: "thread_view/patch", threadId: "thread", turnId: "turn", itemId: null, projectId: null, receivedAt: "2026-10-06T00:00:00Z",
    payload: { scope: "full_snapshot", threadId: "thread", viewRevision: 1, activeTurnId: "turn", liveState: "streaming", turns: [{ id: "turn", status: "inProgress" }], pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [
      { id: "row", turnId: "turn", kind: "assistant_message", status: "inProgress", displayOrder: 1, items: [], collapsedRows: [], fileChanges: [],
        item: { id: "item", itemId: "native", itemType: "agentMessage", threadId: "thread", turnId: "turn", status: "inProgress", displayOrder: 1,
          payload: { item: { id: "native", type: "agentMessage", delivery: "async", questions, text: "Question fallback" }, itemSnapshot: { id: "native", itemType: "agentMessage" } } } },
    ] },
  };
  const state = applyLiveTimelineUpdate(createTimelineState(), event);
  expect(state.items[0].payload).toEqual({});
  expect(state.items[0].asyncQuestions).toEqual(questions);
  const updated = applyLiveTimelineUpdate(state, { ...event, id: "delta", seq: 2, kind: "thread_view.item_delta", payload: { threadId: "thread", turnId: "turn", itemId: "native", viewRevision: 2, delta: " more" } });
  expect(updated.items[0].text).toBe("Question fallback more");
  expect(updated.items[0].asyncQuestions).toEqual(questions);
});
