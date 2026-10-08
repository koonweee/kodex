import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listAutomationRuns, type AutomationRun } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { errorMessageFrom } from "../shared/values";
import { refreshAutomationRuns } from "./runsCache";
import { AutomationRunsView } from "./AutomationRunsView";

const phaseLabels: Record<AutomationRun["phase"], string> = {
  admitting: "Submitting to native queue", queued: "Queued", startRequested: "Start requested",
  dispatched: "Dispatched", rejected: "Rejected", uncertain: "Delivery uncertain", removed: "Removed",
};

export function AutomationRuns({ automationId }: { automationId: string }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.automationRuns(automationId), queryFn: ({ signal }) => listAutomationRuns(automationId, signal) });
  return <AutomationRunsView
    rows={query.data?.map(run => ({
      id: run.id, label: phaseLabels[run.phase], createdAt: run.createdAt, error: run.error,
      color: run.phase === "uncertain" ? "yellow" : run.phase === "rejected" ? "red" : "gray",
      ...(run.phase === "uncertain" ? { detail: "Delivery could not be confirmed. This run will not be automatically resubmitted." } : {}),
    }))}
    error={query.error ? errorMessageFrom(query.error) : null}
    isLoading={query.isPending} onRefresh={() => void refreshAutomationRuns(client, automationId)}
  />;
}
