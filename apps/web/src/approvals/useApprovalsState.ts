import { useCallback, useMemo, useRef, type SetStateAction } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  decideApproval,
  listPendingApprovals,
  type Approval,
  type ApprovalResponse,
  type EventEnvelope,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { applyApprovalEvent, approvalFromPayload, mergePendingApprovals } from "./state";

type UseApprovalsStateParams = {
  selectedThreadId: string | null;
};

export function useApprovalsState({ selectedThreadId }: UseApprovalsStateParams) {
  const queryClient = useQueryClient();
  const resolvedApprovalIds = useRef<Set<string>>(new Set());
  const approvalsQuery = useQuery({
    queryKey: queryKeys.pendingApprovals,
    queryFn: async () => {
      const nextApprovals = await listPendingApprovals();
      return mergePendingApprovals(
        queryClient.getQueryData<Approval[]>(queryKeys.pendingApprovals) ?? [],
        nextApprovals.filter((approval) => !resolvedApprovalIds.current.has(approval.id)),
      );
    },
  });
  const approvals = approvalsQuery.data ?? [];
  const selectedThreadApprovals = useMemo(
    () => (selectedThreadId ? approvals.filter((approval) => approval.threadId === selectedThreadId) : []),
    [approvals, selectedThreadId],
  );
  const decideApprovalMutation = useMutation({
    mutationFn: ({ approval, decision }: { approval: Approval; decision: ApprovalResponse }) =>
      decideApproval(approval.id, decision),
    onSuccess: (resolved, { approval }) => {
      resolvedApprovalIds.current.add(resolved.id);
      setApprovals((current) => current.filter((item) => item.id !== approval.id));
    },
  });

  const setApprovals = useCallback(
    (action: SetStateAction<Approval[]>) => {
      queryClient.setQueryData<Approval[]>(queryKeys.pendingApprovals, (current) =>
        typeof action === "function" ? action(current ?? []) : action,
      );
    },
    [queryClient],
  );

  const handleApprovalDecision = useCallback(
    async (approval: Approval, decision: ApprovalResponse) => {
      await decideApprovalMutation.mutateAsync({ approval, decision });
    },
    [decideApprovalMutation],
  );

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
    setApprovals,
  };
}
