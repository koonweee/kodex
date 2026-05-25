import type { Approval } from "../api/client";
import type { TimelineRow } from "./state";

export type TimelineApprovalIndex = {
  approvals: Approval[];
  byItemId: Map<string, Approval[]>;
  orderByApprovalId: Map<string, number>;
};

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
  const approvals = timelineRowItemIds(row).flatMap((itemId) => approvalIndex.byItemId.get(itemId) ?? []);
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
    return row.itemIds;
  }
  return row.collapsedRows.flatMap(timelineRowItemIds);
}

function hasApprovalItemAnchor(approval: Approval): approval is Approval & { itemId: string } {
  return approval.itemId !== undefined && approval.itemId !== null && approval.itemId !== "";
}
