import type { TimelineFileChangesRow, TimelineItem, TimelineRow, TimelineState } from "./reducer";

export function timelineItem(overrides: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id: "item-1",
    kind: "assistant_message",
    status: "completed",
    text: "",
    turnId: "turn-1",
    displayOrder: 1,
    payload: {},
    debugEvents: [],
    ...overrides,
  };
}

export function timelineState(overrides: Partial<TimelineState> = {}): TimelineState {
  const items = overrides.items ?? [];
  return {
    activeTurnId: null,
    rows: overrides.rows ?? timelineRowsFromItems(items),
    items,
    hiddenItems: overrides.hiddenItems ?? [],
    turns: overrides.turns ?? [],
    pendingApprovalRequests: overrides.pendingApprovalRequests ?? [],
    pendingUserInputRequests: overrides.pendingUserInputRequests ?? [],
    olderCursor: null,
    hasOlderHistory: false,
    isLoadingOlderHistory: false,
    lastSeq: 0,
    viewRevision: 0,
    ...overrides,
  };
}

function timelineItemRow(item: TimelineItem): TimelineRow {
  return {
    type: "item",
    key: `item-${item.id}`,
    turnKey: item.turnId ? `turn-${item.turnId}` : `item-${item.id}`,
    turnId: item.turnId,
    displayOrder: item.displayOrder,
    item,
  };
}

function timelineRowsFromItems(items: TimelineItem[]): TimelineRow[] {
  const ordered = [...items].sort((left, right) => left.displayOrder - right.displayOrder);
  const fileItems = ordered.filter((item) => item.kind === "file_change");
  const user = ordered.find((item) => item.kind === "user_message" && item.turnId === "turn-1");
  const final = ordered.find((item) => item.kind === "assistant_message" && item.messagePhase === "final_answer" && item.turnId === "turn-1");
  if (user && final && fileItems.length > 0) {
    return [
      timelineItemRow(user),
      {
        type: "work",
        key: "work-turn-1",
        turnKey: "turn-turn-1",
        turnId: "turn-1",
        state: "completed",
        startedAtMs: 0,
        completedAtMs: 1000,
        displayOrder: user.displayOrder + 0.1,
        collapsedRows: [fileChangesRow(fileItems)],
      },
      timelineItemRow(final),
      ...ordered.filter((item) => item !== user && item !== final && item.kind !== "file_change").map(timelineItemRow),
    ];
  }
  const rows: TimelineRow[] = [];
  let pendingFiles: TimelineItem[] = [];
  for (const item of ordered) {
    if (item.kind === "file_change") {
      pendingFiles.push(item);
      continue;
    }
    if (pendingFiles.length > 0) {
      rows.push(fileChangesRow(pendingFiles));
      pendingFiles = [];
    }
    rows.push(timelineItemRow(item));
  }
  if (pendingFiles.length > 0) {
    rows.push(fileChangesRow(pendingFiles));
  }
  return rows;
}

function fileChangesRow(items: TimelineItem[]): TimelineFileChangesRow {
  const first = items[0];
  return {
    type: "file_changes",
    key: `file-changes-${first.turnId ?? first.id}`,
    turnKey: first.turnId ? `turn-${first.turnId}` : `item-${first.id}`,
    turnId: first.turnId,
    itemIds: items.map((item) => item.id),
    displayOrder: first.displayOrder,
    entries: items.map((item) => ({
      id: `file-change-${item.id}`,
      action: item.action ? `${item.action.charAt(0).toUpperCase()}${item.action.slice(1)}` : "Modified",
      additions: item.output?.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length ?? 0,
      deletions: item.output?.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length ?? 0,
      diff: item.output ?? "",
      itemIds: [item.id],
      path: item.path ?? "unknown",
    })),
  };
}
