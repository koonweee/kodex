import { Button, Center, MantineProvider, Stack, Text } from "@mantine/core";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { currentKodexRoute } from "../shell/browserRouting";
import type { InstanceStorage } from "./instanceStorage";
import { createInstanceStorage } from "./instanceStorage";
import {
  createFederationRegistrySubscription,
  createFederatorClient,
  type ExecutorRegistryEvent,
} from "./federatorClient";
import { ExecutorRuntimeRegistry, type ExecutorRuntime } from "./queryClient";

type FederatorBootstrapClient = Pick<ReturnType<typeof createFederatorClient>, "getHealth" | "listExecutors">;
type RegistrySubscription = (options: { onEvent: (event: ExecutorRegistryEvent) => void }) => () => void;
const RESTART_UNCHECKED_ERROR = "Executor has not been checked since federator restart.";

export type FederatedRuntimeSnapshot = {
  availableExecutorIds: readonly string[];
  defaultRuntime: ExecutorRuntime;
  defaultRuntimeAvailable: boolean;
  routeAvailable: boolean;
  routeError: string | null;
  runtimes: readonly ExecutorRuntime[];
  workspaceStorage: InstanceStorage | null;
};

export function FederatedInstanceBoundary({
  children,
  client: providedClient,
  registry: providedRegistry,
  subscribe = createFederationRegistrySubscription,
}: {
  children: (snapshot: FederatedRuntimeSnapshot) => ReactNode;
  client?: FederatorBootstrapClient;
  registry?: ExecutorRuntimeRegistry;
  subscribe?: RegistrySubscription;
}) {
  const clientRef = useRef<FederatorBootstrapClient | null>(null);
  clientRef.current ??= providedClient ?? createFederatorClient();
  const client = clientRef.current;
  const registryRef = useRef(providedRegistry ?? new ExecutorRuntimeRegistry({ retainRemoved: true }));
  const initialRoute = currentKodexRoute();
  const [routeExecutorId, setRouteExecutorId] = useState(() => initialRoute.executorId ?? null);
  const [unqualifiedResourceRoute, setUnqualifiedResourceRoute] = useState(
    () => !initialRoute.executorId && Boolean(initialRoute.threadId || initialRoute.projectId || initialRoute.view === "automations"),
  );
  const knownRuntimesRef = useRef(new Map<string, ExecutorRuntime>());
  const [snapshot, setSnapshot] = useState<{
    availableExecutorIds: readonly string[];
    federatorId: string;
    runtimes: readonly ExecutorRuntime[];
  } | null>(null);
  const [defaultRuntime, setDefaultRuntime] = useState<ExecutorRuntime | null>(null);
  const defaultRuntimeRef = useRef<ExecutorRuntime | null>(null);
  defaultRuntimeRef.current = defaultRuntime;
  const acceptedPathRef = useRef(`${window.location.pathname}${window.location.search}`);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    try {
      const [health, executors] = await Promise.all([client.getHealth(), client.listExecutors()]);
      const entries = await registryRef.current.synchronize(executors);
      if (generation !== requestGeneration.current) return;
      for (const entry of entries) knownRuntimesRef.current.set(entry.executor.id, entry.runtime);
      const availableEntries = entries
        .filter((entry) => entry.executor.enabled && (
          entry.executor.status === "ready"
          || (entry.executor.status === "unknown" && entry.executor.lastError === RESTART_UNCHECKED_ERROR)
        ))
      const availableExecutorIds = availableEntries.map((entry) => entry.executor.id);
      const availableRuntimes = availableEntries.map((entry) => entry.runtime);
      const runtimes = Array.from(knownRuntimesRef.current.values());
      setSnapshot({ availableExecutorIds, federatorId: health.instanceId, runtimes });
      setDefaultRuntime((current) => {
        if (current) {
          return runtimes.find((runtime) => runtime.connection.executorId === current.connection.executorId) ?? current;
        }
        const requestedExecutorId = currentKodexRoute().executorId;
        const requested = requestedExecutorId
          ? availableRuntimes.find((runtime) => runtime.connection.executorId === requestedExecutorId)
          : null;
        if (requested) return requested;
        return availableRuntimes[0] ?? null;
      });
      setError(null);
    } catch {
      if (generation === requestGeneration.current) setError("Unable to connect to the Kodex federator.");
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribe({ onEvent: () => { void refresh(); } });
    const updateRoute = () => {
      const route = currentKodexRoute();
      const shellExecutorId = defaultRuntimeRef.current?.connection.executorId;
      if (route.executorId && shellExecutorId && route.executorId !== shellExecutorId && !route.threadId) {
        window.history.replaceState(window.history.state, "", acceptedPathRef.current);
        setNavigationError(`Open executor ${route.executorId} project and automation routes in a new tab.`);
        return;
      }
      acceptedPathRef.current = `${window.location.pathname}${window.location.search}`;
      setNavigationError(null);
      setRouteExecutorId(route.executorId ?? null);
      setUnqualifiedResourceRoute(!route.executorId && Boolean(route.threadId || route.projectId || route.view === "automations"));
    };
    window.addEventListener("popstate", updateRoute);
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      requestGeneration.current += 1;
      unsubscribe();
      window.removeEventListener("popstate", updateRoute);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, [refresh, subscribe]);

  if (!snapshot) {
    return <BootstrapStatus error={error} onRetry={refresh} />;
  }
  if (unqualifiedResourceRoute) {
    return <BootstrapStatus error="Federated Kodex links must name an executor." onRetry={refresh} />;
  }
  if (!defaultRuntime) {
    const message = routeExecutorId
      ? `Executor ${routeExecutorId} is unavailable.`
      : "No executors are registered with this Kodex federator.";
    return <BootstrapStatus error={message} onRetry={refresh} />;
  }
  return children({
    availableExecutorIds: snapshot.availableExecutorIds,
    defaultRuntime,
    defaultRuntimeAvailable: snapshot.availableExecutorIds.includes(defaultRuntime.connection.executorId),
    routeAvailable: !navigationError && (!routeExecutorId || snapshot.availableExecutorIds.includes(routeExecutorId)),
    routeError: navigationError ?? (routeExecutorId && !snapshot.availableExecutorIds.includes(routeExecutorId)
      ? `Executor ${routeExecutorId} is unavailable.`
      : null),
    runtimes: snapshot.runtimes,
    workspaceStorage: createInstanceStorage(snapshot.federatorId),
  });
}

function BootstrapStatus({ error, onRetry }: { error: string | null; onRetry: () => Promise<void> }) {
  return (
    <MantineProvider>
      <Center mih="100dvh" p="md">
        <Stack align="center">
          <Text role={error ? "alert" : "status"}>{error ?? "Connecting to Kodex…"}</Text>
          {error ? <Button onClick={() => { void onRetry(); }}>Retry</Button> : null}
        </Stack>
      </Center>
    </MantineProvider>
  );
}
