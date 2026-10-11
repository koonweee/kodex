import { Alert, Select, Stack, Text } from "@mantine/core";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  ExecutorRuntimeBoundary,
  useExecutorConnection,
  useExecutorRuntimes,
} from "../api/GatewayClientContext";
import { useFederatedCatalogContext } from "../federation/FederatedCatalogContext";
import { applyAccountEvent, refreshAccountQueries, refreshUsageQueries } from "../account/cache";
import type { EventEnvelope } from "../api/client";
import { usageLimitSnapshotFromEvent } from "../account/rateLimits";
import { applyUsageLimitSnapshotToCache } from "../account/useUsageLimits";
import { applyNativeConfigEvent, refreshNativeConfig } from "../api/nativeConfigCache";
import { useOptionalWorkspace } from "../workspace/WorkspaceProvider";

export function ExecutorPreferencesScope({ children }: { children: ReactNode }) {
  const federation = useFederatedCatalogContext();
  const runtimes = useExecutorRuntimes();
  const currentExecutorId = useExecutorConnection()?.executorId ?? null;
  const executorOptions = useMemo(() => federation?.executors.flatMap((executor) => (
    runtimes?.has(executor.id) ? [{ label: executor.displayName, value: executor.id }] : []
  )) ?? [], [federation?.executors, runtimes]);
  const [executorId, setExecutorId] = useState(() => currentExecutorId ?? executorOptions[0]?.value ?? null);

  useEffect(() => {
    if (executorId && executorOptions.some((option) => option.value === executorId)) return;
    const fallback = executorOptions.find((option) => option.value === currentExecutorId)?.value
      ?? executorOptions[0]?.value
      ?? null;
    setExecutorId(fallback);
  }, [currentExecutorId, executorId, executorOptions]);

  if (!federation || !runtimes) return children;
  const selected = executorOptions.find((option) => option.value === executorId) ?? null;
  return <Stack gap="sm">
    <Select
      aria-label="Executor"
      data={executorOptions}
      label="Executor"
      onChange={(value) => { if (value) setExecutorId(value); }}
      value={executorId}
    />
    {selected ? <Text c="dimmed" size="xs">Settings for {selected.label}</Text> : null}
    {executorId ? (
      <ExecutorRuntimeBoundary
        executorId={executorId}
        fallback={<Alert color="yellow">{selected?.label ?? "This executor"} is unavailable. Its settings cannot be changed.</Alert>}
        key={executorId}
        preserveChildrenWhenUnavailable
        showChildrenWhenUnavailable
      >
        <ExecutorPreferencesLiveEvents />
        {children}
      </ExecutorRuntimeBoundary>
    ) : <Alert color="yellow">Register an executor to manage native settings.</Alert>}
  </Stack>;
}

function ExecutorPreferencesLiveEvents() {
  const connection = useExecutorConnection();
  const queryClient = useQueryClient();
  const workspace = useOptionalWorkspace();
  const subscribeLiveEvent = workspace?.subscribeLiveEvent;
  useEffect(() => {
    if (!connection || !subscribeLiveEvent) return;
    const unsubscribe = subscribeLiveEvent(connection.executorId, (event) => routeExecutorPreferencesEvent(queryClient, event));
    void Promise.all([
      refreshAccountQueries(queryClient, { cancelInFlight: true }),
      refreshUsageQueries(queryClient),
      refreshNativeConfig(queryClient),
    ]);
    return unsubscribe;
  }, [connection, queryClient, subscribeLiveEvent]);
  return null;
}

export function routeExecutorPreferencesEvent(queryClient: QueryClient, event: EventEnvelope) {
  const usage = usageLimitSnapshotFromEvent(event);
  if (usage) applyUsageLimitSnapshotToCache(queryClient, usage);
  applyAccountEvent(queryClient, event);
  void applyNativeConfigEvent(queryClient, event);
}
