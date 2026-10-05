import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope, ThreadViewResponse } from "../api/client";
import { applyTimelineEventBatch } from "./batch";
import { applyLiveTimelineUpdate, applyTimelineSnapshot, canApplyThreadViewItemDelta, createTimelineState } from "./reducer";
import { useTimelineEventQueue } from "./useTimelineEventQueue";

function snapshot(text: string, viewRevision: number): ThreadViewResponse {
  return {
    thread: {
      id: "thread-1", parentThreadId: null, canAcceptDirectInput: true,
      cwd: "/workspace", status: "active", createdAt: 0, updatedAt: 0,
      notificationsEnabled: true, latestCompletedTurnId: null, seenCompletedTurnId: null,
      readRevision: 0, readStateKnown: true, unreadCompletedAgentTurn: false,
    },
    liveState: "streaming",
    timeline: {
      viewRevision, activeTurnId: "turn-1", liveState: "streaming",
      pendingApprovalRequests: [], pendingUserInputRequests: [],
      turns: [{ id: "turn-1", status: "inProgress" }],
      rows: [{
        id: "answer", kind: "assistant_message", status: "inProgress", turnId: "turn-1", displayOrder: 1,
        item: {
          id: "answer", itemId: "answer", itemType: "agentMessage", threadId: "thread-1", turnId: "turn-1",
          status: "inProgress", displayOrder: 1, codexMethod: "item/started",
          payload: {
            source: "gatewayStream", turnId: "turn-1", itemId: "answer",
            item: { id: "answer", type: "agentMessage", text },
            itemSnapshot: { id: "answer", itemType: "agentMessage" },
          },
        },
        items: [], fileChanges: [], collapsedRows: [],
      }],
    },
  };
}

function delta(text: string, viewRevision: number, seq = viewRevision): EventEnvelope {
  return {
    id: `delta-${seq}`, seq, kind: "thread_view.item_delta", threadId: "thread-1",
    turnId: "turn-1", itemId: "answer", receivedAt: "2026-10-05T00:00:00Z",
    payload: { threadId: "thread-1", turnId: "turn-1", itemId: "answer", delta: text, viewRevision },
  };
}

function patch(text: string, viewRevision: number, seq: number, liveState: ThreadViewResponse["liveState"] = "streaming"): EventEnvelope {
  return {
    id: `patch-${seq}`, seq, kind: "thread_view.patch", threadId: "thread-1", receivedAt: "2026-10-05T00:00:00Z",
    payload: {
      ...snapshot(text, viewRevision).timeline,
      scope: "full_snapshot", threadId: "thread-1", liveState, activeTurnId: liveState === "idle" ? null : "turn-1",
    },
  };
}

function client() {
  return renderHook(() => {
    const [timeline, setTimeline] = useState(() => applyTimelineSnapshot(createTimelineState(), snapshot("Seed", 1)));
    const queue = useTimelineEventQueue({ setTimeline, timeline, reduceEvents: applyTimelineEventBatch, flushDelayMs: 64 });
    return {
      timeline,
      receive: queue.enqueueTimelineEvent,
      read: (next: ThreadViewResponse) => setTimeline((current) => applyTimelineSnapshot(current, next)),
    };
  });
}

describe("canonical snapshots during batched text streaming", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps streamed text when an older in-flight snapshot arrives, while a missed-event client refills", () => {
    vi.useFakeTimers();
    const first = client();
    const second = client();
    act(() => {
      first.result.current.receive(delta(" A", 2, 10));
      first.result.current.receive(delta(" B", 3, 11));
      first.result.current.receive(delta(" C", 4, 12));
      vi.advanceTimersByTime(64);
    });
    expect(first.result.current.timeline.items.map((item) => item.text)).toEqual(["Seed A B C"]);

    act(() => {
      // Captured before B/C, but delivered after their queued batch applied.
      first.result.current.read(snapshot("Seed A", 2));
      second.result.current.read(snapshot("Seed A B C", 4));
    });
    for (const tab of [first, second]) {
      expect(tab.result.current.timeline.items.map((item) => item.text)).toEqual(["Seed A B C"]);
      expect(tab.result.current.timeline.activeTurnId).toBe("turn-1");
      expect(tab.result.current.timeline.viewRevision).toBe(4);
    }
  });

  it("removes snapshot-covered delta prefixes before coalescing an unflushed batch", () => {
    vi.useFakeTimers();
    const first = client();
    const second = client();
    act(() => {
      first.result.current.receive(delta(" A", 2, 10));
      first.result.current.receive(delta(" B", 3, 11));
      first.result.current.receive(delta(" C", 4, 12));
      // HTTP wins before the 64ms flush, covering only the first two deltas.
      first.result.current.read(snapshot("Seed A B", 3));
      second.result.current.read(snapshot("Seed A B C", 4));
    });
    act(() => { vi.advanceTimersByTime(64); });
    for (const tab of [first, second]) {
      expect(tab.result.current.timeline.items.map((item) => item.text)).toEqual(["Seed A B C"]);
      expect(tab.result.current.timeline.viewRevision).toBe(4);
    }
  });

  it("uses projection revision rather than a later envelope cursor as the snapshot fence", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Seed", 1));
    state = applyLiveTimelineUpdate(state, delta(" A", 2, 20));
    expect(state.viewRevision).toBe(2);
    expect(state.lastSeq).toBe(20);
    state = applyTimelineSnapshot(state, snapshot("Canonical replacement", 3));
    // An older projection can carry a later envelope cursor after unrelated SQL
    // events; that does not make its already-covered text new again.
    state = applyLiveTimelineUpdate(state, delta(" A", 2, 21));
    expect(state.items.map((item) => item.text)).toEqual(["Canonical replacement"]);
    state = applyLiveTimelineUpdate(state, {
      ...delta("", 3, 22), kind: "thread_view.refresh_required", payload: { threadId: "thread-1", reason: "refresh" },
    });
    state = applyTimelineSnapshot(state, snapshot("Fresh canonical text", 4));
    expect(state.items.map((item) => item.text)).toEqual(["Fresh canonical text"]);
    expect(state.viewRevision).toBe(4);
    expect(state.lastSeq).toBe(22);
  });

  it("accepts a newer canonical snapshot after a patch with a later envelope cursor", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Seed", 1));
    state = applyLiveTimelineUpdate(state, patch("Patched answer", 2, 20));
    state = applyTimelineSnapshot(state, snapshot("Fresh canonical answer", 3));
    expect(state.items.map((item) => item.text)).toEqual(["Fresh canonical answer"]);
    expect(state.viewRevision).toBe(3);
    expect(state.lastSeq).toBe(20);
  });

  it("preserves the current active turn when a covered idle patch has a later cursor", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Current active answer", 3));
    state = applyLiveTimelineUpdate(state, patch("Old completed answer", 1, 21, "idle"));
    expect(state.items.map((item) => item.text)).toEqual(["Current active answer"]);
    expect(state.activeTurnId).toBe("turn-1");
    expect(state.viewRevision).toBe(3);
    expect(state.lastSeq).toBe(21);
    state = applyLiveTimelineUpdate(state, delta(" continues", 4, 22));
    expect(state.items.map((item) => item.text)).toEqual(["Current active answer continues"]);
    expect(state.activeTurnId).toBe("turn-1");
    expect(state.viewRevision).toBe(4);
  });

  it.each([
    { kind: "delta", seq: 20 },
    { kind: "delta", seq: 19 },
    { kind: "patch", seq: 20 },
    { kind: "patch", seq: 19 },
  ])("applies a newer $kind projection at transport cursor $seq after an unrelated event", ({ kind, seq }) => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Seed", 1));
    state = applyLiveTimelineUpdate(state, { ...delta("", 1, 20), kind: "automation.run_updated", payload: {} });
    const update = kind === "delta" ? delta(" A", 2, seq) : patch("Seed A", 2, seq);
    state = applyLiveTimelineUpdate(state, update);
    expect(state.items.map((item) => item.text)).toEqual(["Seed A"]);
    expect(state.viewRevision).toBe(2);
    expect(state.lastSeq).toBe(20);

    // A later transport stamp is not a second copy of this projection.
    state = applyLiveTimelineUpdate(state, { ...update, seq: 21 });
    expect(state.items.map((item) => item.text)).toEqual(["Seed A"]);
    expect(state.viewRevision).toBe(2);
    expect(state.lastSeq).toBe(21);
  });

  it("orders a batch by projection revisions and does not concatenate duplicate deltas", () => {
    const initial = applyTimelineSnapshot(createTimelineState(), snapshot("Seed", 1));
    const state = applyTimelineEventBatch(initial, [
      patch("Canonical", 2, 21),
      delta(" A", 3, 20),
      delta(" A", 3, 22),
      delta(" B", 4, 20),
    ]);
    expect(state.items.map((item) => item.text)).toEqual(["Canonical A B"]);
    expect(state.viewRevision).toBe(4);
    expect(state.lastSeq).toBe(22);
  });

  it("requires refill for a new unknown delta target even behind the transport cursor", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Seed", 1));
    state = applyLiveTimelineUpdate(state, { ...delta("", 1, 20), kind: "automation.run_updated", payload: {} });
    const update = delta(" New item", 2, 19);
    update.payload = { ...update.payload as object, itemId: "unknown-answer" };
    expect(canApplyThreadViewItemDelta(state, update)).toBe(false);
    expect(state.items.map((item) => item.text)).toEqual(["Seed"]);
  });

  it("does not treat a lifecycle patch as proof that its same-revision text was rendered", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Seed", 1));
    state = applyLiveTimelineUpdate(state, {
      ...patch("", 3, 4),
      payload: { scope: "lifecycle", threadId: "thread-1", viewRevision: 3, liveState: "streaming", activeTurnId: "turn-1", pendingApprovalRequests: [], pendingUserInputRequests: [] },
    });
    const lateText = delta(" A", 3, 4);
    expect(canApplyThreadViewItemDelta(state, lateText)).toBe(false);
    state = applyTimelineSnapshot(state, snapshot("Seed A", 3));
    expect(canApplyThreadViewItemDelta(state, lateText)).toBe(true);
    expect(applyLiveTimelineUpdate(state, lateText).items.map((item) => item.text)).toEqual(["Seed A"]);
  });

  it("keeps same-revision lifecycle and text in a batch until a complete projection covers both", () => {
    const initial = applyTimelineSnapshot(createTimelineState(), snapshot("Seed", 1));
    const lifecycle = {
      ...patch("", 3, 4),
      payload: { scope: "lifecycle", threadId: "thread-1", viewRevision: 3, liveState: "streaming", activeTurnId: "turn-1", pendingApprovalRequests: [], pendingUserInputRequests: [] },
    };
    const lateText = delta(" A", 3, 4);
    let state = applyTimelineEventBatch(initial, [lifecycle, lateText]);
    expect(state.snapshotRefillIntent).not.toBeNull();
    expect(state.items.map((item) => item.text)).toEqual(["Seed"]);

    state = applyLiveTimelineUpdate(state, patch("Seed A", 3, 4));
    state = applyTimelineEventBatch(state, [lifecycle, lateText]);
    expect(state.items.map((item) => item.text)).toEqual(["Seed A"]);
    expect(state.snapshotRefillIntent).toBeNull();
  });

  it.each([false, true])("does not hide uncertain delta coverage inside a newer merged chunk (earlier text rendered: %s)", (rendered) => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot("Seed", 1));
    if (rendered) state = applyLiveTimelineUpdate(state, delta(" A", 2));
    state = applyLiveTimelineUpdate(state, {
      ...patch("", 3, 3),
      payload: { scope: "lifecycle", threadId: "thread-1", viewRevision: 3, liveState: "streaming", activeTurnId: "turn-1", pendingApprovalRequests: [], pendingUserInputRequests: [] },
    });
    state = applyTimelineEventBatch(state, [delta(" A", 2), delta(" C", 4)]);
    expect(state.snapshotRefillIntent).not.toBeNull();
    expect(state.items.map((item) => item.text)).toEqual([rendered ? "Seed A C" : "Seed C"]);
    state = applyTimelineSnapshot(state, snapshot("Seed A C", 4));
    state = applyTimelineEventBatch(state, [delta(" A", 2), delta(" C", 4)]);
    expect(state.items.map((item) => item.text)).toEqual(["Seed A C"]);
    expect(state.snapshotRefillIntent).toBeNull();
  });
});
