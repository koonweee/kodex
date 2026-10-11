import { QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useLayoutEffect, useMemo, useRef } from "react";

import type { GatewayClient } from "./gatewayClient";
import { createKodexQueryClient, type ExecutorRuntime } from "./queryClient";
import type { ExecutorConnection } from "./executorConnection";
import type { InstanceStorage } from "./instanceStorage";

const GatewayClientContext = createContext<GatewayClient | null>(null);
type ExecutorRuntimeRegistryValue = {
  availableExecutorIds: ReadonlySet<string>;
  runtimes: ReadonlyMap<string, ExecutorRuntime>;
};
const ExecutorRuntimeRegistryContext = createContext<ExecutorRuntimeRegistryValue | null>(null);
type GatewayRuntimeEnvironment = {
  available: boolean;
  beforeConnect?: () => Promise<boolean>;
  connection?: ExecutorConnection;
  onConnected?: () => void;
  storage: InstanceStorage | null;
};
const GatewayRuntimeEnvironmentContext = createContext<GatewayRuntimeEnvironment>({ available: true, storage: null });
const unavailableSynchronousUrlMethods = new Set<PropertyKey>([
  "filePreviewUrl",
  "skillIconUrl",
  "terminalWebSocketUrl",
]);

function unavailableClientResult(property: PropertyKey) {
  if (property === "sendThreadViewPresenceSnapshotBeacon") return false;
  return Promise.reject(new Error("Executor unavailable."));
}

export function GatewayClientProvider({
  children,
  client,
}: {
  children: ReactNode;
  client: GatewayClient;
}) {
  return <GatewayClientContext.Provider value={client}>{children}</GatewayClientContext.Provider>;
}

export function useGatewayClient(): GatewayClient {
  const client = useContext(GatewayClientContext);
  if (!client) throw new Error("Gateway client context is missing.");
  return client;
}

export function useGatewayInstanceStorage(): InstanceStorage | null {
  return useContext(GatewayRuntimeEnvironmentContext).storage;
}

export function useGatewayInstanceValidation() {
  return useContext(GatewayRuntimeEnvironmentContext).beforeConnect;
}

export function useGatewayStreamConnected() {
  return useContext(GatewayRuntimeEnvironmentContext).onConnected;
}

export function useExecutorConnection() {
  return useContext(GatewayRuntimeEnvironmentContext).connection;
}

export function useExecutorRuntimeAvailable(): boolean {
  return useContext(GatewayRuntimeEnvironmentContext).available;
}

export function useExecutorRuntimes(): ReadonlyMap<string, ExecutorRuntime> | null {
  return useContext(ExecutorRuntimeRegistryContext)?.runtimes ?? null;
}

export function useAvailableExecutorIds(): ReadonlySet<string> | null {
  return useContext(ExecutorRuntimeRegistryContext)?.availableExecutorIds ?? null;
}

export function GatewayRuntimeEnvironmentProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: GatewayRuntimeEnvironment;
}) {
  return <GatewayRuntimeEnvironmentContext.Provider value={value}>{children}</GatewayRuntimeEnvironmentContext.Provider>;
}

export function ExecutorRuntimeProvider({
  available = true,
  children,
  runtime,
}: {
  available?: boolean;
  children: ReactNode;
  runtime: ExecutorRuntime;
}) {
  const runtimeKey = `${runtime.connection.executorId}:${runtime.connection.instanceId}`;
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const availableRef = useRef(available);
  availableRef.current = available;
  const clientRef = useRef<GatewayClient | null>(null);
  clientRef.current ??= new Proxy({} as GatewayClient, {
    get: (_target, property) => {
      const value = runtimeRef.current.api[property as keyof GatewayClient];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => availableRef.current || unavailableSynchronousUrlMethods.has(property)
        ? Reflect.apply(value, runtimeRef.current.api, args)
        : unavailableClientResult(property);
    },
  });
  const previousAvailableRef = useRef(available);
  useLayoutEffect(() => {
    if (previousAvailableRef.current === available) return;
    previousAvailableRef.current = available;
    void runtime.queryClient.cancelQueries().then(() => {
      if (availableRef.current) return runtime.queryClient.resetQueries();
      runtime.queryClient.clear();
    });
  }, [available, runtime.queryClient]);
  const beforeConnect = useCallback(async () => {
    if (!availableRef.current) return false;
    try {
      const capabilities = await runtime.api.getCapabilities();
      return capabilities.gateway.instanceId === runtime.connection.instanceId;
    } catch {
      return false;
    }
  }, [runtime]);
  const onConnected = useCallback(() => {
    void runtime.queryClient.invalidateQueries();
  }, [runtime]);
  const environment = useMemo(() => ({
    available,
    beforeConnect,
    connection: runtime.connection,
    onConnected,
    storage: runtime.storage,
  }), [available, beforeConnect, onConnected, runtime.connection, runtime.storage]);
  return (
    <QueryClientProvider key={runtimeKey} client={runtime.queryClient}>
      <GatewayClientProvider client={clientRef.current}>
        <GatewayRuntimeEnvironmentProvider value={environment}>{children}</GatewayRuntimeEnvironmentProvider>
      </GatewayClientProvider>
    </QueryClientProvider>
  );
}

export function FederatedShellRuntimeProvider({
  available = true,
  children,
  runtime,
}: {
  available?: boolean;
  children: ReactNode;
  runtime: ExecutorRuntime;
}) {
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const availableRef = useRef(available);
  availableRef.current = available;
  const queryClientRef = useRef<ReturnType<typeof createKodexQueryClient> | null>(null);
  queryClientRef.current ??= createKodexQueryClient();
  const queryClient = queryClientRef.current;
  const clientRef = useRef<GatewayClient | null>(null);
  clientRef.current ??= new Proxy({} as GatewayClient, {
    get: (_target, property) => {
      const value = runtimeRef.current.api[property as keyof GatewayClient];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => availableRef.current || unavailableSynchronousUrlMethods.has(property)
        ? Reflect.apply(value, runtimeRef.current.api, args)
        : unavailableClientResult(property);
    },
  });
  const runtimeKey = `${runtime.connection.executorId}:${runtime.connection.instanceId}:${available ? "available" : "unavailable"}`;
  const previousRuntimeKeyRef = useRef(runtimeKey);
  useLayoutEffect(() => {
    if (previousRuntimeKeyRef.current === runtimeKey) return;
    previousRuntimeKeyRef.current = runtimeKey;
    void queryClient.cancelQueries().then(() => {
      if (availableRef.current) return queryClient.resetQueries();
      queryClient.clear();
    });
  }, [queryClient, runtimeKey]);
  const beforeConnect = useCallback(async () => {
    if (!availableRef.current) return false;
    try {
      const current = runtimeRef.current;
      const capabilities = await current.api.getCapabilities();
      return capabilities.gateway.instanceId === current.connection.instanceId;
    } catch {
      return false;
    }
  }, []);
  const onConnected = useCallback(() => {
    void queryClient.invalidateQueries();
  }, [queryClient]);
  const environment = useMemo(() => ({
    available,
    beforeConnect,
    connection: runtime.connection,
    onConnected,
    storage: runtime.storage,
  }), [available, beforeConnect, onConnected, runtime.connection, runtime.storage]);
  return (
    <QueryClientProvider client={queryClient}>
      <GatewayClientProvider client={clientRef.current}>
        <GatewayRuntimeEnvironmentProvider value={environment}>{children}</GatewayRuntimeEnvironmentProvider>
      </GatewayClientProvider>
    </QueryClientProvider>
  );
}

export function ExecutorRuntimeRegistryProvider({
  availableExecutorIds,
  children,
  runtimes,
}: {
  availableExecutorIds?: readonly string[];
  children: ReactNode;
  runtimes: readonly ExecutorRuntime[];
}) {
  const value = useMemo(
    () => ({
      availableExecutorIds: new Set(availableExecutorIds ?? runtimes.map((runtime) => runtime.connection.executorId)),
      runtimes: new Map(runtimes.map((runtime) => [runtime.connection.executorId, runtime])),
    }),
    [availableExecutorIds, runtimes],
  );
  return <ExecutorRuntimeRegistryContext.Provider value={value}>{children}</ExecutorRuntimeRegistryContext.Provider>;
}

export function ExecutorRuntimeBoundary({
  children,
  executorId,
  fallback = null,
  preserveChildrenWhenUnavailable = false,
  showChildrenWhenUnavailable = false,
}: {
  children: ReactNode;
  executorId: string;
  fallback?: ReactNode;
  preserveChildrenWhenUnavailable?: boolean;
  showChildrenWhenUnavailable?: boolean;
}) {
  const currentConnection = useExecutorConnection();
  const registry = useContext(ExecutorRuntimeRegistryContext);
  if (!registry && !currentConnection) return children;
  if (registry) {
    const runtime = registry.runtimes.get(executorId);
    if (!runtime) return fallback;
    const available = registry.availableExecutorIds.has(executorId);
    if (!available && !preserveChildrenWhenUnavailable) {
      return <ExecutorRuntimeProvider available={false} runtime={runtime}>{fallback}</ExecutorRuntimeProvider>;
    }
    return (
      <ExecutorRuntimeProvider available={available} runtime={runtime}>
        <div
          aria-hidden={!available && !showChildrenWhenUnavailable ? true : undefined}
          inert={!available && !showChildrenWhenUnavailable ? true : undefined}
          style={{ display: !available && !showChildrenWhenUnavailable ? "none" : "contents" }}
        >
          {children}
        </div>
        {available ? null : fallback}
      </ExecutorRuntimeProvider>
    );
  }
  return currentConnection?.executorId === executorId ? children : fallback;
}
