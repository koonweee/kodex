import type { ApprovalListResponse, EventEnvelope } from "../api/client";

export function isApprovalEvent(event: EventEnvelope): boolean {
  return event.kind === "approval.changed";
}

export function reconcileApprovalSnapshot(next: ApprovalListResponse, current?: ApprovalListResponse): ApprovalListResponse {
  // Runtime identity comes only from an uncached, non-cancelled HTTP read.
  // Revisions are comparable within that runtime; rows always replace the set.
  return current && current.runtimeId === next.runtimeId && current.revision > next.revision ? current : next;
}
