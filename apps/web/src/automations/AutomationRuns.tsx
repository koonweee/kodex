import { Alert, Badge, Button, Group, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listAutomationRuns, type AutomationRun } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { errorMessageFrom } from "../shared/values";
import { refreshAutomationRuns } from "./runsCache";
import { formatAutomationDate } from "./schedule";

const phaseLabels: Record<AutomationRun["phase"], string> = {
  admitting: "Submitting to native queue", queued: "Queued", startRequested: "Start requested",
  dispatched: "Dispatched", rejected: "Rejected", uncertain: "Delivery uncertain", removed: "Removed",
};

export function AutomationRuns({ automationId }: { automationId: string }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.automationRuns(automationId), queryFn: ({ signal }) => listAutomationRuns(automationId, signal) });
  return <Stack gap="sm" mah={280} style={{ overflowY: "auto" }} role="region" aria-label="Automation runs">
    <Group justify="space-between"><Text fw={600}>Recent runs</Text><Button size="compact-sm" variant="subtle" onClick={() => void refreshAutomationRuns(client, automationId)}>Refresh runs</Button></Group>
    {query.error ? <Alert color="red">{errorMessageFrom(query.error)}</Alert> : null}
    {query.isPending ? <Text size="sm">Loading runs…</Text> : null}
    {query.data?.length === 0 ? <Text size="sm" c="dimmed">No runs recorded.</Text> : null}
    {query.data?.map((run) => <Stack key={run.id} gap={4}>
      <Group gap="xs"><Badge variant="light" color={run.phase === "uncertain" ? "yellow" : run.phase === "rejected" ? "red" : "gray"}>{phaseLabels[run.phase]}</Badge><Text size="xs" c="dimmed">{formatAutomationDate(run.createdAt)}</Text></Group>
      {run.error ? <Text size="sm">{run.error}</Text> : null}
      {run.phase === "uncertain" ? <Text size="xs">Delivery could not be confirmed. This run will not be automatically resubmitted.</Text> : null}
    </Stack>)}
  </Stack>;
}
