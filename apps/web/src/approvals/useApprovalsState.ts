import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { decideApproval, listPendingApprovals, type Approval, type ApprovalListResponse, type ApprovalResponse } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { refreshApprovalSnapshot } from "./cache";
import { reconcileApprovalSnapshot } from "./state";

export function useApprovalsState({ onError }: { onError: (error: unknown) => void }) {
  const queryClient = useQueryClient();
  const approvalsQuery = useQuery({
    queryKey: queryKeys.pendingApprovals,
    queryFn: async ({ signal }) => reconcileApprovalSnapshot(
      await listPendingApprovals(signal),
      queryClient.getQueryData<ApprovalListResponse>(queryKeys.pendingApprovals),
    ),
  });
  const { mutate } = useMutation({
    mutationFn: ({ approval, decision }: { approval: Approval; decision: ApprovalResponse }) => decideApproval(approval.id, decision),
    onError,
    // A failed write can also leave a native request responding. Only the next
    // authoritative snapshot decides whether it is still actionable.
    onSettled: () => refreshApprovalSnapshot(queryClient),
  });
  const handleApprovalDecision = useCallback((approval: Approval, decision: ApprovalResponse) => {
    mutate({ approval, decision });
  }, [mutate]);

  return { approvals: approvalsQuery.data?.approvals ?? [], handleApprovalDecision };
}
