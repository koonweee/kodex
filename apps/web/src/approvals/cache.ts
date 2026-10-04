import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { isApprovalEvent } from "./state";

export async function refreshApprovalSnapshot(queryClient: QueryClient) {
  await queryClient.cancelQueries({ queryKey: queryKeys.pendingApprovals });
  await queryClient.invalidateQueries({ queryKey: queryKeys.pendingApprovals }, { cancelRefetch: false });
}

export function applyApprovalInvalidation(queryClient: QueryClient, event: EventEnvelope) {
  if (!isApprovalEvent(event)) return;
  // A marker from another runtime can only request a fresh snapshot, never
  // supply rows or select the runtime accepted by this client.
  void refreshApprovalSnapshot(queryClient);
}
