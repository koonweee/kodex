import { describe, expect, it } from "vitest";

import {
  buildApprovalIndex,
  deriveTimelineRows,
  getTimelineRowApprovals,
  getUnanchoredApprovals,
} from "./derive";
import { approval, timelineItem, timelineState } from "./testBuilders";

describe("timeline derivation", () => {
  it("derives large timeline rows in sequence order across messages, activity, and debug items", () => {
    const timeline = timelineState({
      items: [
        timelineItem({ id: "answer-1", kind: "assistant_message", seq: 8, text: "Done." }),
        timelineItem({ id: "user-1", kind: "user_message", seq: 1, text: "Please inspect this." }),
        timelineItem({ id: "cmd-1", kind: "command_execution", seq: 4, command: "rg timeline" }),
        timelineItem({ id: "file-1", kind: "file_change", seq: 5, path: "apps/web/src/App.tsx" }),
        timelineItem({ id: "warning-1", kind: "warning", seq: 7, text: "Low confidence" }),
        timelineItem({ id: "reasoning-1", kind: "reasoning_summary", seq: 2, summary: "Need context." }),
        timelineItem({
          id: "web-search-turn-1",
          kind: "web_search_group",
          seq: 3,
          actions: [{ kind: "search", query: "timeline performance" }],
        }),
      ],
      hiddenItems: [timelineItem({ id: "debug-hidden-1", kind: "debug_event", seq: 6, text: "turn/completed" })],
    });

    const rows = deriveTimelineRows(timeline, { showDebug: true });

    expect(rows.map((row) => row.key)).toEqual([
      "item-user-1",
      "item-reasoning-1",
      "activity-web-search-turn-1",
      "item-debug-hidden-1",
      "item-warning-1",
      "item-answer-1",
    ]);
    expect(rows.map((row) => row.type)).toEqual(["item", "item", "activity", "item", "item", "item"]);
    expect(rows[2]).toMatchObject({
      type: "activity",
      items: [{ id: "web-search-turn-1" }, { id: "cmd-1" }, { id: "file-1" }],
      turnKey: "turn-turn-1",
    });
  });

  it("merges debug items without mutating reducer-owned timeline arrays", () => {
    const timeline = timelineState({
      items: [
        timelineItem({ id: "visible-later", seq: 2 }),
        timelineItem({ id: "visible-earlier", seq: 1 }),
      ],
      hiddenItems: [timelineItem({ id: "debug-earliest", kind: "debug_event", seq: 0 })],
    });

    const originalItems = [...timeline.items];
    const originalHiddenItems = [...timeline.hiddenItems];

    expect(deriveTimelineRows(timeline).map((row) => row.key)).toEqual(["item-visible-earlier", "item-visible-later"]);
    expect(deriveTimelineRows(timeline, { showDebug: true }).map((row) => row.key)).toEqual([
      "item-debug-earliest",
      "item-visible-earlier",
      "item-visible-later",
    ]);
    expect(timeline.items).toEqual(originalItems);
    expect(timeline.hiddenItems).toEqual(originalHiddenItems);
    expect(timeline.items.map((item) => item.id)).toEqual(["visible-later", "visible-earlier"]);
  });

  it("pre-indexes approvals for single rows, activity groups, and unanchored placement", () => {
    const timeline = timelineState({
      items: [
        timelineItem({ id: "user-1", kind: "user_message", seq: 1 }),
        timelineItem({ id: "cmd-1", kind: "command_execution", seq: 2 }),
        timelineItem({ id: "file-1", kind: "file_change", seq: 3 }),
        timelineItem({ id: "answer-1", kind: "assistant_message", seq: 4 }),
      ],
    });
    const rows = deriveTimelineRows(timeline);
    const indexed = buildApprovalIndex([
      approval({ id: "approval-unanchored" }),
      approval({ id: "approval-answer", itemId: "answer-1" }),
      approval({ id: "approval-missing", itemId: "missing-item" }),
      approval({ id: "approval-command", itemId: "cmd-1" }),
      approval({ id: "approval-file", itemId: "file-1" }),
    ]);

    const activityRow = rows.find((row) => row.type === "activity");
    const answerRow = rows.find((row) => row.type === "item" && row.item.id === "answer-1");

    expect(activityRow).toBeDefined();
    expect(answerRow).toBeDefined();
    expect(getTimelineRowApprovals(activityRow!, indexed).map((item) => item.id)).toEqual([
      "approval-command",
      "approval-file",
    ]);
    expect(getTimelineRowApprovals(answerRow!, indexed).map((item) => item.id)).toEqual(["approval-answer"]);
    expect(getUnanchoredApprovals(rows, indexed).map((item) => item.id)).toEqual([
      "approval-unanchored",
      "approval-missing",
    ]);
  });

  it("marks final assistant responses for a divider only after prior visible work in the same turn", () => {
    const rows = deriveTimelineRows(
      timelineState({
        items: [
          timelineItem({ id: "user-1", kind: "user_message", seq: 1, text: "Please inspect this." }),
          timelineItem({ id: "cmd-1", kind: "command_execution", seq: 2, command: "rg timeline" }),
          timelineItem({
            id: "answer-1",
            kind: "assistant_message",
            messagePhase: "final_answer",
            seq: 3,
            text: "I found the issue.",
          }),
          timelineItem({ id: "user-2", kind: "user_message", seq: 4, text: "Thanks." }),
          timelineItem({
            id: "answer-2",
            kind: "assistant_message",
            messagePhase: "final_answer",
            seq: 5,
            text: "You're welcome.",
            turnId: "turn-2",
          }),
        ],
      }),
    );

    expect(rows.find((row) => row.key === "item-answer-1")).toMatchObject({ dividerBefore: "final_response" });
    expect(rows.find((row) => row.key === "item-answer-2")).not.toHaveProperty("dividerBefore");
  });

  it("renders an active turn work row before intermediate messages", () => {
    const rows = deriveTimelineRows(
      timelineState({
        activeTurnId: "turn-1",
        turns: [{ turnId: "turn-1", itemIds: ["user-1", "reasoning-1"], status: "inProgress", startedAtMs: 1_000 }],
        items: [
          timelineItem({ id: "user-1", kind: "user_message", seq: 1, text: "Inspect this." }),
          timelineItem({ id: "reasoning-1", kind: "reasoning_summary", seq: 2, summary: "Need context." }),
        ],
      }),
    );

    expect(rows.map((row) => row.key)).toEqual(["item-user-1", "work-turn-1", "item-reasoning-1"]);
    expect(rows[1]).toMatchObject({
      type: "work",
      state: "running",
      turnId: "turn-1",
      startedAtMs: 1_000,
    });
  });

  it("collapses completed turn work before the final answer divider", () => {
    const rows = deriveTimelineRows(
      timelineState({
        turns: [
          {
            turnId: "turn-1",
            itemIds: ["user-1", "reasoning-1", "cmd-1", "answer-1"],
            status: "completed",
            startedAtMs: 1_000,
            completedAtMs: 6_000,
          },
        ],
        items: [
          timelineItem({ id: "user-1", kind: "user_message", seq: 1, text: "Inspect this." }),
          timelineItem({ id: "reasoning-1", kind: "reasoning_summary", seq: 2, summary: "Need context." }),
          timelineItem({ id: "cmd-1", kind: "command_execution", seq: 3, command: "rg issue" }),
          timelineItem({
            id: "answer-1",
            kind: "assistant_message",
            messagePhase: "final_answer",
            seq: 4,
            text: "Done.",
          }),
        ],
      }),
    );

    expect(rows.map((row) => row.key)).toEqual(["item-user-1", "work-turn-1", "item-answer-1"]);
    expect(rows[1]).toMatchObject({
      type: "work",
      state: "completed",
      startedAtMs: 1_000,
      completedAtMs: 6_000,
      collapsedRows: [
        { type: "item", item: { id: "reasoning-1" } },
        { type: "activity", items: [{ id: "cmd-1" }] },
      ],
    });
    expect(rows[2]).not.toHaveProperty("dividerBefore");
  });

  it("keeps generated images visible outside completed turn work", () => {
    const rows = deriveTimelineRows(
      timelineState({
        turns: [
          {
            turnId: "turn-1",
            itemIds: ["user-1", "cmd-1", "image-1", "answer-1"],
            status: "completed",
            startedAtMs: 1_000,
            completedAtMs: 6_000,
          },
        ],
        items: [
          timelineItem({ id: "user-1", kind: "user_message", seq: 1, text: "Generate an image." }),
          timelineItem({ id: "cmd-1", kind: "command_execution", seq: 2, command: "open image tool" }),
          timelineItem({
            id: "image-1",
            kind: "image_generation",
            seq: 3,
            imageSrc: "data:image/png;base64,iVBORw0KGgo=",
            path: "/tmp/generated.png",
            text: "Generated image",
          }),
          timelineItem({
            id: "answer-1",
            kind: "assistant_message",
            messagePhase: "final_answer",
            seq: 4,
            text: "Done.",
          }),
        ],
      }),
    );

    expect(rows.map((row) => row.key)).toEqual(["item-user-1", "work-turn-1", "item-image-1", "item-answer-1"]);
    expect(rows[1]).toMatchObject({
      type: "work",
      collapsedRows: [{ type: "activity", items: [{ id: "cmd-1" }] }],
    });
    expect(rows[2]).toMatchObject({
      type: "item",
      item: { id: "image-1", kind: "image_generation" },
    });
    expect(rows[3]).not.toHaveProperty("dividerBefore");
  });

  it("keeps context compaction markers visible outside completed turn work", () => {
    const rows = deriveTimelineRows(
      timelineState({
        turns: [
          {
            turnId: "turn-1",
            itemIds: ["user-1", "cmd-1", "compact-1", "answer-1"],
            status: "completed",
            startedAtMs: 1_000,
            completedAtMs: 6_000,
          },
        ],
        items: [
          timelineItem({ id: "user-1", kind: "user_message", seq: 1, text: "Compact context." }),
          timelineItem({ id: "cmd-1", kind: "command_execution", seq: 2, command: "prepare context" }),
          timelineItem({
            id: "compact-1",
            kind: "context_compaction",
            seq: 3,
            status: "completed",
            text: "Context compacted",
          }),
          timelineItem({
            id: "answer-1",
            kind: "assistant_message",
            messagePhase: "final_answer",
            seq: 4,
            text: "Done.",
          }),
        ],
      }),
    );

    expect(rows.map((row) => row.key)).toEqual(["item-user-1", "work-turn-1", "item-compact-1", "item-answer-1"]);
    expect(rows[1]).toMatchObject({
      type: "work",
      collapsedRows: [{ type: "activity", items: [{ id: "cmd-1" }] }],
    });
    expect(rows[2]).toMatchObject({
      type: "item",
      item: { id: "compact-1", kind: "context_compaction", text: "Context compacted" },
    });
    expect(rows[3]).not.toHaveProperty("dividerBefore");
  });

  it("keeps activity row keys stable as groups grow and chunks large activity runs", () => {
    const initialRows = deriveTimelineRows(
      timelineState({
        items: [timelineItem({ id: "cmd-1", kind: "command_execution", seq: 1 })],
      }),
    );
    const grownRows = deriveTimelineRows(
      timelineState({
        items: [
          timelineItem({ id: "cmd-1", kind: "command_execution", seq: 1 }),
          timelineItem({ id: "file-1", kind: "file_change", seq: 2 }),
        ],
      }),
    );

    expect(initialRows[0].key).toBe("activity-cmd-1");
    expect(grownRows[0].key).toBe(initialRows[0].key);
    expect(grownRows[0]).toMatchObject({ type: "activity", items: [{ id: "cmd-1" }, { id: "file-1" }] });

    const chunkedRows = deriveTimelineRows(
      timelineState({
        items: Array.from({ length: 30 }, (_, index) =>
          timelineItem({ id: `cmd-${index}`, kind: "command_execution", seq: index + 1 }),
        ),
      }),
    );

    expect(chunkedRows).toHaveLength(3);
    expect(chunkedRows.map((row) => row.key)).toEqual(["activity-cmd-0", "activity-cmd-12", "activity-cmd-24"]);
    expect(chunkedRows.every((row) => row.type === "activity" && row.items.length <= 12)).toBe(true);
  });
});
