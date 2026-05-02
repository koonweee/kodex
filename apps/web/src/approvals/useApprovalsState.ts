import { useCallback, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

import {
  decideApproval,
  type Approval,
  type ApprovalResponse,
  type EventEnvelope,
} from "../api/client";
import { applyApprovalEvent, approvalFromPayload, mergePendingApprovals } from "./state";

type UseApprovalsStateParams = {
  selectedThreadId: string | null;
};

export function useApprovalsState({ selectedThreadId }: UseApprovalsStateParams) {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const resolvedApprovalIds = useRef<Set<string>>(new Set());
  const selectedThreadApprovals = useMemo(
    () => (selectedThreadId ? approvals.filter((approval) => approval.threadId === selectedThreadId) : []),
    [approvals, selectedThreadId],
  );

  const handleApprovalDecision = useCallback(async (approval: Approval, decision: ApprovalResponse) => {
    const resolved = await decideApproval(approval.id, decision);
    resolvedApprovalIds.current.add(resolved.id);
    setApprovals((current) => current.filter((item) => item.id !== approval.id));
  }, []);

  function mergeFetchedPendingApprovals(nextApprovals: Approval[]) {
    setApprovals((current) =>
      mergePendingApprovals(
        current,
        nextApprovals.filter((approval) => !resolvedApprovalIds.current.has(approval.id)),
      ),
    );
  }

  function applyApprovalEventsWithTombstone(current: Approval[], events: EventEnvelope[]): Approval[] {
    return events.reduce(applyApprovalEventWithTombstone, current);
  }

  function applyApprovalEventWithTombstone(current: Approval[], event: EventEnvelope): Approval[] {
    const approval = approvalFromPayload(event.payload);
    if (approval) {
      if (event.kind === "approval.resolved" || approval.status !== "pending") {
        resolvedApprovalIds.current.add(approval.id);
      } else if (resolvedApprovalIds.current.has(approval.id)) {
        return current;
      }
    }
    return applyApprovalEvent(current, event);
  }

  return {
    approvals,
    applyApprovalEventWithTombstone,
    applyApprovalEventsWithTombstone,
    handleApprovalDecision,
    mergeFetchedPendingApprovals,
    selectedThreadApprovals,
    setApprovals: setApprovals as Dispatch<SetStateAction<Approval[]>>,
  };
}
