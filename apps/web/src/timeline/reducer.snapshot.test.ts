import { describe, expect, it } from "vitest";

import type { EventEnvelope, ThreadViewResponse } from "../api/client";
import { applyLiveTimelineUpdate, applyTimelineHistoryWindow, applyTimelineSnapshot, canApplyThreadViewItemDelta, createTimelineState } from "./reducer";

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
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ type: "item" });
    expect(state.activeTurnId).toBe("turn-1");
    expect(state.viewRevision).toBe(2);
  });

  it("replaces hidden diagnostic items on canonical full snapshot patches", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      items: [],
      rows: [
        canonicalRow(timelineItem({
          id: "projection-turn-1-hook-1",
          itemId: "hook-1",
          itemType: "hookPrompt",
          text: "",
        })),
      ],
    }));
    expect(state.hiddenItems.map((item) => item.id)).toEqual(["projection-turn-1-hook-1"]);

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 2,
      items: [timelineItem({ itemId: "agent-1", text: "Canonical answer" })],
    }));

    expect(state.items.map((item) => item.text)).toEqual(["Canonical answer"]);
    expect(state.hiddenItems).toEqual([]);
  });

  it("replaces hidden diagnostic items for affected turn patches only", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      items: [],
      rows: [
        canonicalRow(timelineItem({
          id: "projection-turn-1-hook-1",
          itemId: "hook-1",
          itemType: "hookPrompt",
          text: "",
          turnId: "turn-1",
        })),
        canonicalRow(timelineItem({
          id: "projection-turn-2-hook-1",
          itemId: "hook-2",
          itemType: "hookPrompt",
          text: "",
          turnId: "turn-2",
        })),
      ],
    }));
    expect(state.hiddenItems.map((item) => item.id)).toEqual([
      "projection-turn-1-hook-1",
      "projection-turn-2-hook-1",
    ]);

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 2,
      affectedTurnIds: ["turn-1"],
      rows: [
        canonicalRow(timelineItem({
          id: "projection-turn-1-agent-1",
          itemId: "agent-1",
          text: "Turn one answer",
          turnId: "turn-1",
        })),
      ],
    }));

    expect(state.items.map((item) => item.text)).toEqual(["Turn one answer"]);
    expect(state.hiddenItems.map((item) => item.id)).toEqual(["projection-turn-2-hook-1"]);
  });

  it("ignores unscoped canonical patch rows instead of inferring full snapshots from rows", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      items: [timelineItem({ text: "Original" })],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      scope: null,
      viewRevision: 2,
      items: [timelineItem({ text: "Legacy unscoped replacement" })],
    }));

    expect(state.items.map((item) => item.text)).toEqual(["Original"]);
    expect(state.rows).toHaveLength(1);
    expect(state.viewRevision).toBe(1);
    expect(state.lastSeq).toBe(2);
  });

  it("ignores turn-scoped patches that carry full rows", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [timelineItem({ text: "Original" })],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      scope: "turn",
      viewRevision: 2,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [timelineItem({ text: "Malformed row replacement" })],
      rows: [canonicalRow(timelineItem({ text: "Malformed row replacement" }))],
    }));

    expect(state.items.map((item) => item.text)).toEqual(["Original"]);
    expect(state.rows).toHaveLength(1);
    expect(state.viewRevision).toBe(2);
    expect(state.lastSeq).toBe(2);
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

  it("merges stale history windows without overwriting newer live rows", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 10,
      activeTurnId: "turn-2",
      liveState: "streaming",
      items: [timelineItem({ id: "projection-turn-2-agent-1", turnId: "turn-2", text: "Fresh live", displayOrder: 2 })],
      rows: [
        canonicalRow(
          timelineItem({ id: "projection-turn-2-agent-1", turnId: "turn-2", text: "Fresh live", displayOrder: 2 }),
          { displayOrder: 300 },
        ),
      ],
    }));

    const olderItem = timelineItem({
      id: "projection-turn-1-agent-1",
      turnId: "turn-1",
      itemId: "agent-1",
      text: "Older",
      displayOrder: 1,
    });
    const staleLiveItem = timelineItem({
      id: "projection-turn-2-agent-1",
      turnId: "turn-2",
      text: "Stale live",
      displayOrder: 2,
    });
    const fileChangeItem = timelineItem({
      id: "projection-turn-1-file-1",
      turnId: "turn-1",
      itemId: "file-1",
      itemType: "fileChange",
      text: "",
      displayOrder: 2,
    });
    state = applyTimelineHistoryWindow(state, snapshot({
      viewRevision: 9,
      activeTurnId: null,
      liveState: "idle",
      historyPage: { olderCursor: "older-2", newerCursor: null, hasOlder: true, limit: 50, loadedTurnCount: 2 },
      items: [olderItem, fileChangeItem, staleLiveItem],
      rows: [
        canonicalRow(olderItem, { displayOrder: 100 }),
        fileChangesRow(fileChangeItem, { displayOrder: 200 }),
        canonicalRow(staleLiveItem, { displayOrder: 300, text: "Fresh live" }),
      ],
    }));

    expect(state.items.map((item) => item.text)).toEqual(["Older", "Fresh live"]);
    expect(state.rows.map((row) => row.type)).toEqual(["item", "file_changes", "item"]);
    expect(state.rows.map((row) => row.displayOrder)).toEqual([100, 200, 300]);
    expect(state.olderCursor).toBe("older-2");
    expect(state.hasOlderHistory).toBe(true);
    expect(state.viewRevision).toBe(10);
  });

  it("replaces the loaded window when the gateway marks a stale cursor reset", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 10,
      items: [
        timelineItem({ id: "projection-turn-1-agent-1", turnId: "turn-1", text: "Loaded older", displayOrder: 1 }),
        timelineItem({ id: "projection-turn-2-agent-1", turnId: "turn-2", text: "Recent", displayOrder: 2 }),
      ],
    }));

    state = applyTimelineHistoryWindow(state, snapshot({
      viewRevision: 11,
      historyPage: {
        olderCursor: "older-fresh",
        newerCursor: null,
        hasOlder: true,
        limit: 50,
        loadedTurnCount: 1,
        resetWindow: true,
      },
      items: [
        timelineItem({ id: "projection-turn-3-agent-1", turnId: "turn-3", text: "Fresh recent", displayOrder: 1 }),
      ],
    }));

    expect(state.items.map((item) => item.text)).toEqual(["Fresh recent"]);
    expect(state.olderCursor).toBe("older-fresh");
    expect(state.hasOlderHistory).toBe(true);
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
      rows: [
        canonicalRow(timelineItem({ id: "projection-turn-1-agent-1", turnId: "turn-1", itemId: "agent-1", text: "First" })),
        canonicalRow(timelineItem({ id: "projection-turn-2-agent-1", turnId: "turn-2", itemId: "agent-1", text: "Second" })),
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

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ type: "item" });
    expect(state.turns).toMatchObject([
      { turnId: "turn-1", status: "completed", startedAtMs: 1_000, completedAtMs: 5_000 },
    ]);
  });

  it("converts canonical work row timestamps from seconds to milliseconds", () => {
    const state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 4,
      turns: [{ id: "turn-1", status: "completed", startedAt: 10, completedAt: 20 }],
      items: [],
      rows: [workRow({ startedAt: 10, completedAt: 20 })],
    }));

    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({
      type: "work",
      startedAtMs: 10_000,
      completedAtMs: 20_000,
    });
  });

  it("applies complete turn rows without replacing the loaded timeline", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      items: [
        timelineItem({ id: "projection-turn-1-agent-1", turnId: "turn-1", itemId: "agent-1", text: "First", displayOrder: 1 }),
        timelineItem({ id: "projection-turn-2-agent-1", turnId: "turn-2", itemId: "agent-2", text: "Second", displayOrder: 2 }),
      ],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 2,
      activeTurnId: "turn-2",
      liveState: "streaming",
      affectedTurnIds: ["turn-2"],
      rows: [
        canonicalRow(timelineItem({
          id: "projection-turn-2-agent-1",
          turnId: "turn-2",
          itemId: "agent-2",
          text: "Second updated",
          displayOrder: 2,
          status: "running",
        })),
      ],
    }));

    expect(state.items.map((item) => item.text)).toEqual(["First", "Second updated"]);
    expect(state.rows.map((row) => row.key)).toEqual([
      "row-projection-turn-1-agent-1",
      "row-projection-turn-2-agent-1",
    ]);
    expect(state.viewRevision).toBe(2);
  });

  it("drops stale rows from the same turn when a complete turn patch reshapes that turn", () => {
    const user = timelineItem({
      id: "projection-turn-1-user-1",
      turnId: "turn-1",
      itemId: "user-1",
      itemType: "userMessage",
      text: "Change files",
      displayOrder: 1,
    });
    const file = timelineItem({
      id: "projection-turn-1-file-1",
      turnId: "turn-1",
      itemId: "file-1",
      itemType: "fileChange",
      text: "",
      displayOrder: 2,
    });
    const answer = timelineItem({
      id: "projection-turn-1-agent-1",
      turnId: "turn-1",
      itemId: "agent-1",
      text: "Done",
      displayOrder: 3,
    });
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [user, file],
      rows: [
        canonicalRow(user),
        workRow({ turnId: "turn-1", displayOrder: 101, state: "running" }),
        fileChangesRow(file, { displayOrder: 200 }),
      ],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 2,
      activeTurnId: null,
      liveState: "idle",
      affectedTurnIds: ["turn-1"],
      rows: [
        canonicalRow(user),
        workRow({
          turnId: "turn-1",
          displayOrder: 101,
          state: "completed",
          collapsedRows: [fileChangesRow(file, { displayOrder: 200 })],
        }),
        canonicalRow(answer, { displayOrder: 300 }),
      ],
    }));

    expect(state.rows.map((row) => row.key)).toEqual([
      "row-projection-turn-1-user-1",
      "work-turn-1",
      "row-projection-turn-1-agent-1",
    ]);
    expect(state.rows.filter((row) => row.type === "file_changes")).toHaveLength(0);
    expect(state.rows.find((row) => row.type === "work")).toMatchObject({
      type: "work",
      collapsedRows: [{ type: "file_changes" }],
    });

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      viewRevision: 3,
      activeTurnId: null,
      liveState: "idle",
      affectedTurnIds: ["turn-1"],
      rows: [canonicalRow(user)],
    }));

    expect(state.rows.map((row) => row.key)).toEqual(["row-projection-turn-1-user-1"]);
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

  it("applies row-delta patches by stable row id while preserving omitted same-turn rows", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [
        timelineItem({
          id: "projection-turn-1-user-1",
          itemId: "user-1",
          itemType: "userMessage",
          text: "Question",
          displayOrder: 1,
        }),
        timelineItem({
          id: "projection-turn-1-agent-1",
          itemId: "agent-1",
          text: "Draft",
          displayOrder: 2,
          status: "running",
        }),
      ],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      scope: "row_delta",
      viewRevision: 2,
      activeTurnId: "turn-1",
      liveState: "streaming",
      affectedTurnIds: ["turn-1"],
      rows: [
        canonicalRow(timelineItem({
          id: "projection-turn-1-agent-1",
          itemId: "agent-1",
          text: "Draft plus work",
          displayOrder: 2,
          status: "running",
        })),
      ],
    }));

    expect(state.items.map((item) => item.text)).toEqual(["Question", "Draft plus work"]);
    expect(state.rows.map((row) => row.key)).toEqual([
      "row-projection-turn-1-user-1",
      "row-projection-turn-1-agent-1",
    ]);
    expect(state.viewRevision).toBe(2);
  });

  it("ignores row-delta patches when the affected turn base is missing", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [timelineItem({ text: "Existing", status: "running" })],
    }));

    const orphanRowDelta = projectionPatchEvent({
      scope: "row_delta",
      viewRevision: 2,
      activeTurnId: "turn-2",
      liveState: "streaming",
      affectedTurnIds: ["turn-2"],
      rows: [
        canonicalRow(timelineItem({
          id: "projection-turn-2-agent-2",
          turnId: "turn-2",
          itemId: "agent-2",
          text: "Orphan delta",
          displayOrder: 2,
          status: "running",
        })),
      ],
    });

    expect(canApplyThreadViewItemDelta(state, orphanRowDelta)).toBe(false);
    state = applyLiveTimelineUpdate(state, orphanRowDelta);

    expect(state.items.map((item) => item.text)).toEqual(["Existing"]);
    expect(state.viewRevision).toBe(1);
    expect(state.lastSeq).toBe(2);
  });

  it("ignores row-delta patches unless every affected turn has a compatible base", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [timelineItem({ text: "Existing", status: "running" })],
    }));

    const mixedBaseRowDelta = projectionPatchEvent({
      scope: "row_delta",
      viewRevision: 2,
      activeTurnId: "turn-2",
      liveState: "streaming",
      affectedTurnIds: ["turn-1", "turn-2"],
      rows: [
        canonicalRow(timelineItem({
          id: "projection-turn-1-agent-1",
          turnId: "turn-1",
          itemId: "agent-1",
          text: "Existing updated",
          displayOrder: 1,
          status: "running",
        })),
        canonicalRow(timelineItem({
          id: "projection-turn-2-agent-2",
          turnId: "turn-2",
          itemId: "agent-2",
          text: "Missing base",
          displayOrder: 2,
          status: "running",
        })),
      ],
    });

    expect(canApplyThreadViewItemDelta(state, mixedBaseRowDelta)).toBe(false);
    state = applyLiveTimelineUpdate(state, mixedBaseRowDelta);

    expect(state.items.map((item) => item.text)).toEqual(["Existing"]);
    expect(state.viewRevision).toBe(1);
    expect(state.lastSeq).toBe(2);
  });

  it("removes only explicit row-delta removals", () => {
    const user = timelineItem({
      id: "projection-turn-1-user-1",
      itemId: "user-1",
      itemType: "userMessage",
      text: "Question",
      displayOrder: 1,
    });
    const agent = timelineItem({
      id: "projection-turn-1-agent-1",
      itemId: "agent-1",
      text: "Draft",
      displayOrder: 2,
      status: "running",
    });
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [user, agent],
      rows: [
        canonicalRow(user),
        canonicalRow(agent),
        workRow({ turnId: "turn-1", displayOrder: 3, state: "running" }),
      ],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      scope: "row_delta",
      viewRevision: 2,
      activeTurnId: "turn-1",
      liveState: "streaming",
      affectedTurnIds: ["turn-1"],
      removedRowIds: ["row-projection-turn-1-agent-1"],
    }));

    expect(state.items.map((item) => item.id)).toEqual(["projection-turn-1-user-1"]);
    expect(state.rows.map((row) => row.key)).toEqual(["row-projection-turn-1-user-1", "work-turn-1"]);
  });

  it("updates hidden diagnostic rows for row-delta changes and removals", () => {
    const hiddenHook = timelineItem({
      id: "projection-turn-1-hook-1",
      itemId: "hook-1",
      itemType: "hookPrompt",
      text: "",
      displayOrder: 1,
    });
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 1,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [],
      rows: [canonicalRow(hiddenHook)],
    }));
    expect(state.hiddenItems.map((item) => item.id)).toEqual(["projection-turn-1-hook-1"]);

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      scope: "row_delta",
      viewRevision: 2,
      activeTurnId: "turn-1",
      liveState: "streaming",
      affectedTurnIds: ["turn-1"],
      rows: [
        canonicalRow(timelineItem({
          id: "projection-turn-1-hook-1",
          itemId: "hook-1",
          text: "Now visible",
          displayOrder: 1,
          status: "running",
        })),
      ],
    }));

    expect(state.items.map((item) => item.id)).toEqual(["projection-turn-1-hook-1"]);
    expect(state.hiddenItems).toEqual([]);

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      scope: "row_delta",
      viewRevision: 3,
      activeTurnId: "turn-1",
      liveState: "streaming",
      affectedTurnIds: ["turn-1"],
      rows: [canonicalRow(hiddenHook)],
    }));

    expect(state.items).toEqual([]);
    expect(state.hiddenItems.map((item) => item.id)).toEqual(["projection-turn-1-hook-1"]);

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      scope: "row_delta",
      viewRevision: 4,
      activeTurnId: "turn-1",
      liveState: "streaming",
      affectedTurnIds: ["turn-1"],
      removedRowIds: ["row-projection-turn-1-hook-1"],
    }));

    expect(state.items).toEqual([]);
    expect(state.hiddenItems).toEqual([]);
  });

  it("keeps existing stale-patch behavior for row-delta revisions", () => {
    let state = applyTimelineSnapshot(createTimelineState(), snapshot({
      viewRevision: 5,
      activeTurnId: "turn-1",
      liveState: "streaming",
      items: [timelineItem({ text: "Fresh", status: "running" })],
    }));

    state = applyLiveTimelineUpdate(state, projectionPatchEvent({
      scope: "row_delta",
      viewRevision: 4,
      activeTurnId: "turn-1",
      liveState: "streaming",
      affectedTurnIds: ["turn-1"],
      rows: [canonicalRow(timelineItem({ text: "Stale", status: "running" }))],
      seq: 6,
    }));

    expect(state.items.map((item) => item.text)).toEqual(["Fresh"]);
    expect(state.viewRevision).toBe(6);
    expect(state.lastSeq).toBe(6);
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
  historyPage,
  rows = items.map((item) => canonicalRow(item)),
  turns = [],
}: {
  viewRevision: number;
  activeTurnId?: string | null;
  liveState?: string;
  items: ReturnType<typeof timelineItem>[];
  rows?: CanonicalTestRow[];
  pendingApprovalRequests?: ReturnType<typeof pendingRequest>[];
  pendingUserInputRequests?: ReturnType<typeof pendingRequest>[];
  historyPage?: ThreadViewResponse["historyPage"];
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
      notificationsEnabled: true,
      pinnedAt: null,
      preview: null,
      lastCompletedAgentTurnSeq: null,
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: false,
      rawPayload: {},
    },
    liveState,
    historyPage,
    timeline: {
      viewRevision,
      activeTurnId,
      liveState,
      pendingApprovalRequests,
      pendingUserInputRequests,
      rows,
      turns,
      items,
    },
  } as ThreadViewResponse;
}

function projectionPatchEvent(payload: {
  viewRevision: number;
  scope?: "full_snapshot" | "turn" | "lifecycle" | "row_delta" | null;
  activeTurnId?: string | null;
  liveState?: string;
  items?: ReturnType<typeof timelineItem>[];
  rows?: CanonicalTestRow[] | undefined;
  affectedTurnIds?: string[];
  removedRowIds?: string[];
  pendingApprovalRequests?: ReturnType<typeof pendingRequest>[];
  pendingUserInputRequests?: ReturnType<typeof pendingRequest>[];
  seq?: number;
}): EventEnvelope {
  const scope = payload.scope ?? (payload.affectedTurnIds !== undefined ? "turn" : "full_snapshot");
  const patchPayload: Record<string, unknown> = {
    threadId: "thread-1",
    activeTurnId: payload.activeTurnId ?? null,
    liveState: payload.liveState ?? "idle",
    viewRevision: payload.viewRevision,
    pendingApprovalRequests: payload.pendingApprovalRequests ?? [],
    pendingUserInputRequests: payload.pendingUserInputRequests ?? [],
    turns: [],
    items: payload.items ?? [],
  };
  if (payload.scope !== null) {
    patchPayload.scope = scope;
  }
  if (payload.rows !== undefined || scope === "full_snapshot") {
    patchPayload.rows = payload.rows ?? (payload.items ?? []).map((item) => canonicalRow(item));
  }
  if (payload.affectedTurnIds !== undefined) {
    patchPayload.affectedTurnIds = payload.affectedTurnIds;
  }
  if (payload.removedRowIds !== undefined) {
    patchPayload.removedRowIds = payload.removedRowIds;
  }
  const seq = payload.seq ?? payload.viewRevision;
  return {
    id: `patch-${payload.viewRevision}`,
    seq,
    kind: "thread_view.patch",
    codexMethod: "thread_view/patch",
    threadId: "thread-1",
    turnId: payload.activeTurnId ?? null,
    itemId: null,
    projectId: null,
    payload: patchPayload,
    receivedAt: "2026-05-17T00:00:00Z",
  } as EventEnvelope;
}

function canonicalRow(
  item: ReturnType<typeof timelineItem>,
  overrides: { displayOrder?: number; text?: string } = {},
) {
  const canonicalItem = overrides.text
    ? {
        ...item,
        payload: {
          ...item.payload,
          item: { id: item.itemId, type: item.itemType, phase: "final_answer", text: overrides.text },
        },
      }
    : item;
  return {
    id: `row-${item.id}`,
    kind: item.itemType === "userMessage" ? "user_message" : "assistant_message",
    turnId: item.turnId,
    displayOrder: overrides.displayOrder ?? item.displayOrder,
    status: item.status,
    timestampMs: item.timestampMs,
    item: canonicalItem,
    items: [],
    fileChanges: [],
    work: null,
    collapsedRows: [],
    dividerBefore: null,
  };
}

function fileChangesRow(item: ReturnType<typeof timelineItem>, overrides: { displayOrder?: number } = {}) {
  return {
    id: `file-changes-${item.turnId}`,
    kind: "file_changes",
    turnId: item.turnId,
    displayOrder: overrides.displayOrder ?? item.displayOrder,
    status: item.status,
    timestampMs: item.timestampMs,
    item: null,
    items: [],
    fileChanges: [
      {
        id: `file-change-${item.id}`,
        path: "src/a.rs",
        action: "Modified",
        additions: 1,
        deletions: 0,
        diff: "+line",
        itemIds: [item.id],
      },
    ],
    work: null,
    collapsedRows: [],
    dividerBefore: null,
  };
}

function workRow({
  turnId = "turn-1",
  startedAt,
  completedAt,
  displayOrder = 1,
  state = "completed",
  collapsedRows = [],
}: {
  turnId?: string;
  startedAt?: number | null;
  completedAt?: number | null;
  displayOrder?: number;
  state?: string;
  collapsedRows?: Array<ReturnType<typeof canonicalRow> | ReturnType<typeof fileChangesRow>>;
}) {
  return {
    id: `work-${turnId}`,
    kind: "work",
    turnId,
    displayOrder,
    status: state,
    timestampMs: null,
    item: null,
    items: [],
    fileChanges: [],
    work: { state, startedAt, completedAt },
    collapsedRows,
    dividerBefore: null,
  };
}

type CanonicalTestRow = ReturnType<typeof canonicalRow> | ReturnType<typeof fileChangesRow> | ReturnType<typeof workRow>;

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
