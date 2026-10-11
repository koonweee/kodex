import { Button, Center, MantineProvider, Stack, Text } from "@mantine/core";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { currentKodexRoute } from "../shell/browserRouting";
import type { InstanceStorage } from "./instanceStorage";
import { createInstanceStorage } from "./instanceStorage";
import {
  createFederationCatalogSubscription,
  createFederationRegistrySubscription,
  createFederatorClient,
  type FederatedCatalog,
  type FederatedExecutor,
  type ExecutorRegistryEvent,
  type QualifiedCatalogRef,
  type RegisterExecutorRequest,
  type UpdateExecutorRequest,
} from "./federatorClient";
import { ExecutorRuntimeRegistry, type ExecutorRuntime } from "./queryClient";
import { useFederatedCatalog, type CatalogSubscription, type FederatorCatalogClient } from "../federation/useFederatedCatalog";

type FederatorBootstrapClient = Pick<ReturnType<typeof createFederatorClient>, "getHealth" | "listExecutors"> & Partial<Pick<
  ReturnType<typeof createFederatorClient>,
  "probeExecutor" | "registerExecutor" | "removeExecutor" | "updateExecutor"
>>;
type RegistrySubscription = (options: { onEvent: (event: ExecutorRegistryEvent) => void }) => () => void;
const RESTART_UNCHECKED_ERROR = "Executor has not been checked since federator restart.";
const EMPTY_CATALOG: FederatedCatalog = {
  executors: [], orderRevision: 0, pinnedOrder: [], projectOrder: [], revision: 0,
};
const EMPTY_CATALOG_CLIENT: FederatorCatalogClient = {
  getCatalog: async () => EMPTY_CATALOG,
  moveCatalogItem: async (_kind, request) => ({ items: [], orderRevision: request.orderRevision }),
  refreshCatalog: async () => EMPTY_CATALOG,
};

export type FederatedRuntimeSnapshot = {
  availableExecutorIds: readonly string[];
  catalog: FederatedCatalog | null;
  catalogError: string | null;
  catalogRefreshing: boolean;
  defaultRuntime: ExecutorRuntime;
  defaultRuntimeAvailable: boolean;
  executors: readonly FederatedExecutor[];
  moveCatalogItem: (
    kind: "project" | "pinned",
    item: QualifiedCatalogRef,
    before: QualifiedCatalogRef | null,
  ) => Promise<unknown>;
  probeExecutor: (executorId: string) => Promise<FederatedExecutor>;
  registerExecutor: (request: RegisterExecutorRequest) => Promise<FederatedExecutor>;
  removeExecutor: (executorId: string) => Promise<void>;
  refreshCatalog: () => Promise<void>;
  refreshExecutors: () => Promise<void>;
  routeAvailable: boolean;
  routeError: string | null;
  runtimes: readonly ExecutorRuntime[];
  workspaceStorage: InstanceStorage | null;
  updateExecutor: (executorId: string, request: UpdateExecutorRequest) => Promise<FederatedExecutor>;
};

export function FederatedInstanceBoundary({
  children,
  client: providedClient,
  catalogClient: providedCatalogClient,
  registry: providedRegistry,
  subscribe = createFederationRegistrySubscription,
  subscribeCatalog = createFederationCatalogSubscription,
}: {
  children: (snapshot: FederatedRuntimeSnapshot) => ReactNode;
  client?: FederatorBootstrapClient;
  catalogClient?: FederatorCatalogClient;
  registry?: ExecutorRuntimeRegistry;
  subscribe?: RegistrySubscription;
  subscribeCatalog?: CatalogSubscription;
}) {
  const clientRef = useRef<FederatorBootstrapClient | null>(null);
  clientRef.current ??= providedClient ?? createFederatorClient();
  const client = clientRef.current;
  const catalogClientRef = useRef<FederatorCatalogClient | null>(null);
  catalogClientRef.current ??= providedCatalogClient ?? (supportsCatalog(client) ? client : EMPTY_CATALOG_CLIENT);
  const catalogState = useFederatedCatalog({ client: catalogClientRef.current, subscribe: subscribeCatalog });
  const registryRef = useRef(providedRegistry ?? new ExecutorRuntimeRegistry({ retainRemoved: true }));
  const initialRoute = currentKodexRoute();
  const [routeExecutorId, setRouteExecutorId] = useState(() => initialRoute.executorId ?? null);
  const [unqualifiedResourceRoute, setUnqualifiedResourceRoute] = useState(
    () => !initialRoute.executorId && Boolean(initialRoute.threadId || initialRoute.projectId || initialRoute.view === "automations"),
  );
  const knownRuntimesRef = useRef(new Map<string, ExecutorRuntime>());
  const [snapshot, setSnapshot] = useState<{
    availableExecutorIds: readonly string[];
    executors: readonly FederatedExecutor[];
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
        ));
      const availableExecutorIds = availableEntries.map((entry) => entry.executor.id);
      const availableRuntimes = availableEntries.map((entry) => entry.runtime);
      const runtimes = Array.from(knownRuntimesRef.current.values());
      setSnapshot({ availableExecutorIds, executors: executors.executors, federatorId: health.instanceId, runtimes });
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

  const registerExecutor = useCallback(async (request: RegisterExecutorRequest) => {
    if (!client.registerExecutor) throw new Error("Executor management is unavailable.");
    const executor = await client.registerExecutor(request);
    await refresh();
    void catalogState.refresh();
    return executor;
  }, [catalogState.refresh, client, refresh]);
  const updateExecutor = useCallback(async (executorId: string, request: UpdateExecutorRequest) => {
    if (!client.updateExecutor) throw new Error("Executor management is unavailable.");
    const executor = await client.updateExecutor(executorId, request);
    await refresh();
    void catalogState.refresh();
    return executor;
  }, [catalogState.refresh, client, refresh]);
  const removeExecutor = useCallback(async (executorId: string) => {
    if (!client.removeExecutor) throw new Error("Executor management is unavailable.");
    await client.removeExecutor(executorId);
    await refresh();
  }, [client, refresh]);
  const probeExecutor = useCallback(async (executorId: string) => {
    if (!client.probeExecutor) throw new Error("Executor management is unavailable.");
    const executor = await client.probeExecutor(executorId);
    await refresh();
    void catalogState.refresh();
    return executor;
  }, [catalogState.refresh, client, refresh]);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribe({ onEvent: () => { void refresh(); } });
    const updateRoute = () => {
      const route = currentKodexRoute();
      const shellExecutorId = defaultRuntimeRef.current?.connection.executorId;
      if (route.executorId && shellExecutorId && route.executorId !== shellExecutorId && !route.threadId && !route.projectId) {
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
    catalog: catalogState.catalog,
    catalogError: catalogState.error,
    catalogRefreshing: catalogState.refreshing,
    defaultRuntime,
    defaultRuntimeAvailable: snapshot.availableExecutorIds.includes(defaultRuntime.connection.executorId),
    executors: snapshot.executors,
    moveCatalogItem: catalogState.moveItem,
    probeExecutor,
    registerExecutor,
    removeExecutor,
    refreshCatalog: catalogState.refresh,
    refreshExecutors: refresh,
    routeAvailable: !navigationError && (!routeExecutorId || snapshot.availableExecutorIds.includes(routeExecutorId)),
    routeError: navigationError ?? (routeExecutorId && !snapshot.availableExecutorIds.includes(routeExecutorId)
      ? `Executor ${routeExecutorId} is unavailable.`
      : null),
    runtimes: snapshot.runtimes,
    workspaceStorage: createInstanceStorage(snapshot.federatorId),
    updateExecutor,
  });
}

function supportsCatalog(client: FederatorBootstrapClient): client is FederatorBootstrapClient & FederatorCatalogClient {
  const candidate = client as Partial<FederatorCatalogClient>;
  return typeof candidate.getCatalog === "function"
    && typeof candidate.moveCatalogItem === "function"
    && typeof candidate.refreshCatalog === "function";
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
