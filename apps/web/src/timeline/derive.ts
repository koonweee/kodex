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

export type TimelineWorkRow = {
  type: "work";
  key: string;
  turnKey: string;
  turnId: string;
  state: "running" | "completed";
  startedAtMs: number;
  completedAtMs?: number;
  collapsedRows: Array<TimelineItemRow | TimelineActivityRow>;
  seq: number;
};

export type TimelineRow = TimelineItemRow | TimelineActivityRow | TimelineWorkRow;
type TimelineContentRow = TimelineItemRow | TimelineActivityRow;
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
  "file_change",
  "image_generation",
  "image_view",
  "mcp_tool_call",
  "web_search_group",
]);

const MAX_ACTIVITY_ITEMS_PER_ROW = 12;

export function deriveTimelineRows(timeline: TimelineState, options: TimelineDeriveOptions = {}): TimelineRow[] {
  const items = sortedVisibleTimelineItems(timeline, options.showDebug ?? false);
  const rows: TimelineRow[] = [];
  let currentTurnKey: string | null = null;
  let activityItems: TimelineItem[] = [];
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

  for (const item of items) {
    const turnKey = timelineTurnKey(item);
    if (currentTurnKey !== null && currentTurnKey !== turnKey) {
      flushActivityItems();
    }
    currentTurnKey = turnKey;

    if (isTimelineActivityItem(item)) {
      activityItems.push(item);
      continue;
    }

    flushActivityItems();
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
  return insertWorkRows(rows, timeline);
}

export function sortedVisibleTimelineItems(timeline: TimelineState, showDebug: boolean): TimelineItem[] {
  const source = showDebug ? [...timeline.items, ...timeline.hiddenItems] : [...timeline.items];
  return source
    .map((item, index) => ({ item, index }))
    .sort((left, right) => left.item.seq - right.item.seq || left.index - right.index)
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
    if (turn.startedAtMs === undefined) {
      continue;
    }
    const state = isTerminalTurnStatus(turn.status) ? "completed" : "running";
    workRows.set(turn.turnId, {
      type: "work",
      key: `work-${turn.turnId}`,
      turnKey: `turn-${turn.turnId}`,
      turnId: turn.turnId,
      state,
      startedAtMs: turn.startedAtMs,
      completedAtMs: turn.completedAtMs,
      collapsedRows: [],
      seq: Number.MAX_SAFE_INTEGER,
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

  return result.sort((left, right) => firstRowSeq(left) - firstRowSeq(right));
}

function rowsForTurnWithWorkRow(rows: TimelineContentRow[], workRow: TimelineWorkRow): TimelineRow[] {
  const firstWorkIndex = rows.findIndex((row) => rowContainsWorkPrecursor(row));
  if (firstWorkIndex === -1) {
    return rows;
  }
  const finalIndex = rows.findIndex((row, index) => index > firstWorkIndex && rowIsFinalResponse(row));
  if (workRow.state === "completed" && finalIndex !== -1) {
    const seq = firstRowSeq(rows[firstWorkIndex]) + 0.1;
    return [
      ...rows.slice(0, firstWorkIndex + 1),
      {
        ...workRow,
        collapsedRows: rows.slice(firstWorkIndex + 1, finalIndex),
        seq,
      },
      withFinalResponseDivider(rows[finalIndex]),
      ...rows.slice(finalIndex + 1),
    ];
  }
  return [
    ...rows.slice(0, firstWorkIndex + 1),
    { ...workRow, seq: firstRowSeq(rows[firstWorkIndex]) + 0.1 },
    ...rows.slice(firstWorkIndex + 1),
  ];
}

function rowContainsWorkPrecursor(row: TimelineContentRow): boolean {
  return row.type === "item" && row.item.kind === "user_message";
}

function rowIsFinalResponse(row: TimelineContentRow): boolean {
  return row.type === "item" && isFinalResponse(row.item);
}

function withFinalResponseDivider(row: TimelineContentRow): TimelineContentRow {
  return { ...row, dividerBefore: "final_response" };
}

function firstRowSeq(row: TimelineRow): number {
  if (row.type === "item") {
    return row.item.seq;
  }
  if (row.type === "activity") {
    return row.items[0]?.seq ?? Number.MAX_SAFE_INTEGER;
  }
  return row.seq;
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
