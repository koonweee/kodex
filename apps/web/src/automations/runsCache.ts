import type { QueryClient } from "@tanstack/react-query";

import type { EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { asRecord } from "../shared/values";

export async function refreshAutomationRuns(client: QueryClient, automationId?: string) {
  const queryKey = automationId ? queryKeys.automationRuns(automationId) : queryKeys.automationRunsRoot;
  await client.cancelQueries({ queryKey });
  await client.invalidateQueries({ queryKey });
}

export function applyAutomationRunEvent(client: QueryClient, event: EventEnvelope) {
  if (event.kind !== "automation.run_updated") return;
  const id = asRecord(event.payload).automationId;
  if (typeof id === "string") void refreshAutomationRuns(client, id);
}
