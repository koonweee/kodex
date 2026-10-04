import type { ThreadSummary } from "../api/client";
import { preserveNewerThreadReadState } from "./readState";

// Native list/detail reads own membership. Ordinary summary notifications may
// refresh title/status, but are not ordered membership or input-capability snapshots.
export function mergeThreadSummaryMetadata(current: ThreadSummary, update: ThreadSummary): ThreadSummary {
  return {
    ...preserveNewerThreadReadState(current, update),
    projectId: current.projectId,
    section: current.section,
    sectionEnteredAt: current.sectionEnteredAt,
    parentThreadId: current.parentThreadId,
    canAcceptDirectInput: current.canAcceptDirectInput,
  };
}
