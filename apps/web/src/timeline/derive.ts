import type { Approval } from "../api/client";
import type { TimelineItem, TimelineState } from "./reducer";

export type TimelineItemRow = {
  type: "item";
  key: string;
  turnKey: string;
  turnId: string | null;
  item: TimelineItem;
  dividerBefore?: TimelineRowDivider;
};

export type TimelineActivityRow = {
  type: "activity";
  key: string;
  turnKey: string;
  turnId: string | null;
  items: TimelineItem[];
  dividerBefore?: TimelineRowDivider;
};

export type TimelineFileChangesRow = {
  type: "file_changes";
  key: string;
  turnKey: string;
  turnId: string | null;
  items: TimelineItem[];
  dividerBefore?: TimelineRowDivider;
};

export type TimelineWorkRow = {
  type: "work";
  key: string;
  turnKey: string;
  turnId: string;
  state: "running" | "completed";
  startedAtMs?: number;
  completedAtMs?: number;
  collapsedRows: Array<TimelineItemRow | TimelineActivityRow | TimelineFileChangesRow>;
  displayOrder: number;
};

export type TimelineRow = TimelineItemRow | TimelineActivityRow | TimelineFileChangesRow | TimelineWorkRow;
type TimelineContentRow = TimelineItemRow | TimelineActivityRow | TimelineFileChangesRow;
export type TimelineRowDivider = "final_response";

export type TimelineDeriveOptions = {
  showDebug?: boolean;
};

export type TimelineApprovalIndex = {
  approvals: Approval[];
  byItemId: Map<string, Approval[]>;
  orderByApprovalId: Map<string, number>;
};

const timelineActivityKinds = new Set([
  "collab_agent_tool_call",
  "command_execution",
  "dynamic_tool_call",
  "image_view",
  "mcp_tool_call",
  "web_search_group",
]);

const MAX_ACTIVITY_ITEMS_PER_ROW = 12;
export const MAX_FILE_CHANGE_ITEMS_PER_ROW = 12;

export function deriveTimelineRows(timeline: TimelineState, _options: TimelineDeriveOptions = {}): TimelineRow[] {
  const items = timelineItemsInDisplayOrder(timeline);
  const rows: TimelineRow[] = [];
  let currentTurnKey: string | null = null;
  let activityItems: TimelineItem[] = [];
  let fileChangeItems: TimelineItem[] = [];
  const turnHasFinalResponsePrecursor = new Set<string>();

  function flushActivityItems() {
    if (activityItems.length === 0) {
      return;
    }
    for (let index = 0; index < activityItems.length; index += MAX_ACTIVITY_ITEMS_PER_ROW) {
      const rowItems = activityItems.slice(index, index + MAX_ACTIVITY_ITEMS_PER_ROW);
      rows.push(createActivityRow(rowItems));
      markFinalResponsePrecursor(rowItems[0], turnHasFinalResponsePrecursor);
    }
    activityItems = [];
  }

  function flushFileChangeItems() {
    if (fileChangeItems.length === 0) {
      return;
    }
    for (let index = 0; index < fileChangeItems.length; index += MAX_FILE_CHANGE_ITEMS_PER_ROW) {
      const rowItems = fileChangeItems.slice(index, index + MAX_FILE_CHANGE_ITEMS_PER_ROW);
      rows.push(createFileChangesRow(rowItems, index === 0));
      markFinalResponsePrecursor(rowItems[0], turnHasFinalResponsePrecursor);
    }
    fileChangeItems = [];
  }

  for (const item of items) {
    const turnKey = timelineTurnKey(item);
    if (currentTurnKey !== null && currentTurnKey !== turnKey) {
      flushActivityItems();
      flushFileChangeItems();
    }
    currentTurnKey = turnKey;

    if (item.kind === "file_change") {
      fileChangeItems.push(item);
      continue;
    }

    if (isTimelineActivityItem(item)) {
      activityItems.push(item);
      continue;
    }

    flushActivityItems();
    if (isFinalResponse(item)) {
      flushFileChangeItems();
    }
    const row: TimelineItemRow = {
      type: "item",
      key: timelineItemRowKey(item),
      turnKey,
      turnId: item.turnId,
      item,
    };
    if (shouldDivideBeforeFinalResponse(item, turnHasFinalResponsePrecursor)) {
      row.dividerBefore = "final_response";
    }
    rows.push(row);
    if (isFinalResponsePrecursor(item)) {
      markFinalResponsePrecursor(item, turnHasFinalResponsePrecursor);
    }
  }

  flushActivityItems();
  flushFileChangeItems();
  return insertWorkRows(rows, timeline);
}

export function timelineItemsInDisplayOrder(timeline: TimelineState): TimelineItem[] {
  const source = [...timeline.items];
  return source
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.displayOrder - right.item.displayOrder || left.index - right.index)
    .map(({ item }) => item);
}

export function buildApprovalIndex(approvals: Approval[]): TimelineApprovalIndex {
  const byItemId = new Map<string, Approval[]>();
  const orderByApprovalId = new Map<string, number>();

  approvals.forEach((approval, index) => {
    orderByApprovalId.set(approval.id, index);
    if (!hasApprovalItemAnchor(approval)) {
      return;
    }
    const existing = byItemId.get(approval.itemId) ?? [];
    existing.push(approval);
    byItemId.set(approval.itemId, existing);
  });

  return {
    approvals: [...approvals],
    byItemId,
    orderByApprovalId,
  };
}

export function getTimelineRowApprovals(row: TimelineRow, approvalIndex: TimelineApprovalIndex): Approval[] {
  if (row.type === "item") {
    return approvalIndex.byItemId.get(row.item.id) ?? [];
  }
  if (row.type === "work") {
    return row.collapsedRows.flatMap((collapsedRow) => getTimelineRowApprovals(collapsedRow, approvalIndex));
  }

  const approvals = row.items.flatMap((item) => approvalIndex.byItemId.get(item.id) ?? []);
  return approvals.sort(
    (left, right) =>
      (approvalIndex.orderByApprovalId.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
      (approvalIndex.orderByApprovalId.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
}

export function getUnanchoredApprovals(rows: TimelineRow[], approvalIndex: TimelineApprovalIndex): Approval[] {
  const renderedItemIds = new Set(rows.flatMap((row) => timelineRowItemIds(row)));
  return approvalIndex.approvals.filter((approval) => !hasApprovalItemAnchor(approval) || !renderedItemIds.has(approval.itemId));
}

export function timelineRowItemIds(row: TimelineRow): string[] {
  if (row.type === "item") {
    return [row.item.id];
  }
  if (row.type === "activity") {
    return row.items.map((item) => item.id);
  }
  if (row.type === "file_changes") {
    return row.items.map((item) => item.id);
  }
  return row.collapsedRows.flatMap(timelineRowItemIds);
}

export function isTimelineActivityItem(item: TimelineItem): boolean {
  return timelineActivityKinds.has(item.kind);
}

function createActivityRow(items: TimelineItem[]): TimelineActivityRow {
  const first = items[0];
  return {
    type: "activity",
    key: `activity-${first.id}`,
    turnKey: timelineTurnKey(first),
    turnId: first.turnId,
    items: [...items],
  };
}

function createFileChangesRow(items: TimelineItem[], useTurnKey: boolean): TimelineFileChangesRow {
  const first = items[0];
  const turnKey = timelineTurnKey(first);
  return {
    type: "file_changes",
    key: useTurnKey ? `file-changes-${turnKey}` : `file-changes-${first.id}`,
    turnKey,
    turnId: first.turnId,
    items: [...items],
  };
}

function shouldDivideBeforeFinalResponse(item: TimelineItem, turnHasFinalResponsePrecursor: Set<string>): boolean {
  return isFinalResponse(item) && turnHasFinalResponsePrecursor.has(timelineTurnKey(item));
}

function markFinalResponsePrecursor(item: TimelineItem, turnHasFinalResponsePrecursor: Set<string>) {
  turnHasFinalResponsePrecursor.add(timelineTurnKey(item));
}

function isFinalResponsePrecursor(item: TimelineItem): boolean {
  if (item.kind === "user_message") {
    return false;
  }
  return !isFinalResponse(item);
}

function isFinalResponse(item: TimelineItem): boolean {
  return item.kind === "assistant_message" && item.messagePhase === "final_answer";
}

function insertWorkRows(rows: TimelineRow[], timeline: TimelineState): TimelineRow[] {
  const workRows = new Map<string, TimelineWorkRow>();
  for (const turn of timeline.turns) {
    const isActiveTurn = turn.turnId === timeline.activeTurnId;
    const isTerminalTurn = isTerminalTurnStatus(turn.status);
    if (turn.startedAtMs === undefined && !isActiveTurn) {
      continue;
    }
    if (!isActiveTurn && !isTerminalTurn) {
      continue;
    }
    const state = isActiveTurn ? "running" : "completed";
    workRows.set(turn.turnId, {
      type: "work",
      key: `work-${turn.turnId}`,
      turnKey: `turn-${turn.turnId}`,
      turnId: turn.turnId,
      state,
      startedAtMs: turn.startedAtMs,
      completedAtMs: isActiveTurn ? undefined : turn.completedAtMs,
      collapsedRows: [],
      displayOrder: Number.MAX_SAFE_INTEGER,
    });
  }
  if (workRows.size === 0) {
    return rows;
  }

  const byTurn = new Map<string, TimelineRow[]>();
  const turnOrder: string[] = [];
  const result: TimelineRow[] = [];
  for (const row of rows) {
    if (!row.turnId || !workRows.has(row.turnId)) {
      result.push(row);
      continue;
    }
    if (!byTurn.has(row.turnId)) {
      byTurn.set(row.turnId, []);
      turnOrder.push(row.turnId);
    }
    byTurn.get(row.turnId)!.push(row);
  }

  for (const turnId of turnOrder) {
    const turnRows = byTurn.get(turnId) ?? [];
    result.push(...rowsForTurnWithWorkRow(turnRows as TimelineContentRow[], workRows.get(turnId)!));
  }

  return result.sort((left, right) => firstRowDisplayOrder(left) - firstRowDisplayOrder(right));
}

function rowsForTurnWithWorkRow(rows: TimelineContentRow[], workRow: TimelineWorkRow): TimelineRow[] {
  const firstWorkIndex = rows.findIndex((row) => rowContainsWorkPrecursor(row));
  if (firstWorkIndex === -1) {
    return rows;
  }
  const finalIndex = rows.findIndex((row, index) => index > firstWorkIndex && rowIsFinalResponse(row));
  if (workRow.state === "completed" && finalIndex !== -1) {
    const displayOrder = firstRowDisplayOrder(rows[firstWorkIndex]) + 0.1;
    const rowsAfterUser = rows.slice(firstWorkIndex + 1);
    const finalOffset = finalIndex - firstWorkIndex - 1;
    const workDetailRows = rowsAfterUser
      .filter((row, index) => index !== finalOffset && !rowIsProminentTurnResult(row))
      .sort((left, right) => firstRowDisplayOrder(left) - firstRowDisplayOrder(right));
    const prominentRows = rowsAfterUser.filter((row, index) => index !== finalOffset && rowIsProminentTurnResult(row));
    return [
      ...rows.slice(0, firstWorkIndex + 1),
      {
        ...workRow,
        collapsedRows: workDetailRows,
        displayOrder,
      },
      withoutFinalResponseDivider(rows[finalIndex]),
      ...prominentRows,
    ];
  }
  return [
    ...rows.slice(0, firstWorkIndex + 1),
    { ...workRow, displayOrder: firstRowDisplayOrder(rows[firstWorkIndex]) + 0.1 },
    ...rows.slice(firstWorkIndex + 1),
  ];
}

function rowContainsWorkPrecursor(row: TimelineContentRow): boolean {
  return row.type === "item" && row.item.kind === "user_message";
}

function rowIsFinalResponse(row: TimelineContentRow): boolean {
  return row.type === "item" && isFinalResponse(row.item);
}

function rowIsProminentTurnResult(row: TimelineContentRow): boolean {
  return (
    row.type === "item" &&
    (row.item.kind === "user_message" || row.item.kind === "image_generation" || row.item.kind === "context_compaction")
  );
}

function withoutFinalResponseDivider<T extends TimelineContentRow>(row: T): T {
  if (row.dividerBefore !== "final_response") {
    return row;
  }
  const { dividerBefore: _dividerBefore, ...rowWithoutDivider } = row;
  return rowWithoutDivider as T;
}

function firstRowDisplayOrder(row: TimelineRow): number {
  if (row.type === "item") {
    return row.item.displayOrder;
  }
  if (row.type === "activity") {
    return row.items[0]?.displayOrder ?? Number.MAX_SAFE_INTEGER;
  }
  if (row.type === "file_changes") {
    return row.items[0]?.displayOrder ?? Number.MAX_SAFE_INTEGER;
  }
  return row.displayOrder;
}

function isTerminalTurnStatus(status: string | undefined): boolean {
  return ["completed", "failed", "cancelled", "canceled", "interrupted"].includes((status ?? "").toLowerCase());
}

function timelineItemRowKey(item: TimelineItem): string {
  return `item-${item.id}`;
}

function timelineTurnKey(item: TimelineItem): string {
  return item.turnId ? `turn-${item.turnId}` : `item-${item.id}`;
}

function hasApprovalItemAnchor(approval: Approval): approval is Approval & { itemId: string } {
  return approval.itemId !== undefined && approval.itemId !== null && approval.itemId !== "";
}
