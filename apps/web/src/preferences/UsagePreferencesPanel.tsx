import { Alert, Button, Group, Loader, Paper, Progress, Stack, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import type { RateLimitWindow } from "../api/client";
import { refreshUsageQueries } from "../account/cache";
import { formatCreditsRemaining, usageLimitSnapshotFromResponse } from "../account/rateLimits";
import { usageQueryOptions } from "../account/useUsageLimits";
import { useResetCredit } from "../account/useResetCredit";
import "./usage-preferences.css";

const outcomeMessages = {
  reset: "Plan limits reset.",
  alreadyRedeemed: "This reset was already applied.",
  nothingToReset: "No plan limits are currently eligible for a reset.",
  noCredit: "No resets are available. Usage has been refreshed.",
};

export function UsagePreferencesPanel() {
  const queryClient = useQueryClient();
  const query = useQuery(usageQueryOptions(queryClient));
  const reset = useResetCredit();
  const snapshot = query.data ? usageLimitSnapshotFromResponse(query.data) : null;
  const resets = query.data?.rateLimitResetCredits;
  const credits = resets?.credits;

  return (
    <Stack className="kodex-preferences-panel kodex-usage-panel" gap={16}>
      <Group justify="space-between">
        <Text className="kodex-preferences-panel-title" fw={650}>Usage</Text>
        <Button size="xs" variant="subtle" disabled={query.isFetching || reset.isPending} onClick={() => void refreshUsageQueries(queryClient)}>Refresh usage</Button>
      </Group>
      {query.isPending ? <Group gap="xs"><Loader size="xs" /><Text size="sm">Loading usage…</Text></Group> : null}
      {query.error ? <Alert color="red">Could not refresh usage. {query.error.message}</Alert> : null}
      {!query.isPending ? <Text size="sm">{formatCreditsRemaining(snapshot)}</Text> : null}
      <Stack gap={12}>
        <Text component="h3" size="sm" fw={650} m={0}>Plan limits</Text>
        {snapshot?.primary ? <UsageLimitCard window={snapshot.primary} fallbackMinutes={300} /> : null}
        {snapshot?.secondary ? <UsageLimitCard window={snapshot.secondary} fallbackMinutes={10080} /> : null}
        {!query.isPending && !snapshot?.primary && !snapshot?.secondary ? <Text size="sm" c="dimmed">Plan limits unavailable.</Text> : null}
        <Stack gap={12}>
          <Text component="h4" size="sm" fw={600} m={0}>Resets{resets ? ` (${resets.availableCount} available)` : ""}</Text>
          {reset.data ? <Alert color={reset.data.outcome === "reset" || reset.data.outcome === "alreadyRedeemed" ? "green" : "blue"}>{outcomeMessages[reset.data.outcome]}</Alert> : null}
          {reset.error ? <Alert color="red">
            <Stack gap="xs">
              <Text size="sm">Could not confirm the reset. Retry to check the same attempt. {reset.error.message}</Text>
              <Group><Button variant="light" size="xs" onClick={() => reset.variables && reset.useReset(reset.variables.creditId)}>Retry reset</Button></Group>
            </Stack>
          </Alert> : null}
          {!query.isPending && !resets ? <Text size="sm" c="dimmed">Reset information unavailable.</Text> : null}
          {resets && resets.availableCount === 0 ? <Text size="sm" c="dimmed">No resets available.</Text> : null}
          {resets && resets.availableCount > 0 && (!credits || credits.length === 0) ? <Text size="sm" c="dimmed">Reset details unavailable. Refresh to choose a reset.</Text> : null}
          {credits?.map((credit) => {
            const name = credit.title?.trim() || "Plan limit reset";
            const expired = credit.expiresAt != null && credit.expiresAt * 1000 <= Date.now();
            const usable = credit.status === "available" && credit.resetType === "codexRateLimits" && !expired;
            return (
              <div key={credit.id} className="kodex-usage-reset-row">
                <Stack gap={4} className="kodex-usage-reset-copy">
                  <Text size="sm" fw={600}>{name}</Text>
                  {credit.description ? <Text size="sm" c="dimmed">{credit.description}</Text> : null}
                  <Text size="xs" c="dimmed">{credit.expiresAt == null ? "No expiry" : `${expired ? "Expired" : "Expires"} ${formatUsageDate(credit.expiresAt)}`}</Text>
                  {!usable && !expired ? <Text size="xs" c="dimmed">{credit.status === "redeeming" ? "Reset in progress" : "Unavailable"}</Text> : null}
                </Stack>
                  <Button variant="light" size="xs" aria-label={`Use reset: ${name}`}
                    disabled={!usable || reset.isPending || Boolean(reset.error && reset.variables?.creditId !== credit.id)}
                    loading={reset.isPending && reset.variables?.creditId === credit.id}
                    onClick={() => reset.useReset(credit.id)}>Use reset</Button>
              </div>
            );
          })}
          {credits && resets && credits.length > 0 && credits.length < resets.availableCount ? <Text size="xs" c="dimmed">Showing {credits.length} of {resets.availableCount} available resets.</Text> : null}
        </Stack>
      </Stack>
    </Stack>
  );
}

function UsageLimitCard({ window, fallbackMinutes }: { window: RateLimitWindow; fallbackMinutes: number }) {
  const minutes = window.windowDurationMins ?? fallbackMinutes;
  const name = minutes === 10080 ? "Weekly limit" : minutes % 1440 === 0 ? `${minutes / 1440}-day limit` : `${minutes / 60}-hour limit`;
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap={6}>
        <Text size="sm" fw={600}>{name}</Text>
        <Group justify="space-between" gap={6}>
          <Text size="xs" c="dimmed">Resets {window.resetsAt == null ? "at an unknown time" : formatUsageDate(window.resetsAt)}</Text>
          <Text size="xs" c="dimmed">{Math.round(remaining)}% left</Text>
        </Group>
        <Progress value={remaining} size={6} aria-label={`${name} remaining`} />
      </Stack>
    </Paper>
  );
}

function formatUsageDate(seconds: number) {
  return new Date(seconds * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  });
}
