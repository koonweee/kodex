import { QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";

import type { GatewayClient } from "./gatewayClient";
import type { ExecutorRuntime } from "./queryClient";
import type { ExecutorConnection } from "./executorConnection";
import type { InstanceStorage } from "./instanceStorage";

const GatewayClientContext = createContext<GatewayClient | null>(null);
type GatewayRuntimeEnvironment = {
  beforeConnect?: () => Promise<boolean>;
  connection?: ExecutorConnection;
  onConnected?: () => void;
  storage: InstanceStorage | null;
};
const GatewayRuntimeEnvironmentContext = createContext<GatewayRuntimeEnvironment>({ storage: null });

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
  children,
  runtime,
}: {
  children: ReactNode;
  runtime: ExecutorRuntime;
}) {
  const runtimeKey = `${runtime.connection.executorId}:${runtime.connection.instanceId}`;
  const beforeConnect = useCallback(async () => {
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
    beforeConnect,
    connection: runtime.connection,
    onConnected,
    storage: runtime.storage,
  }), [beforeConnect, onConnected, runtime.connection, runtime.storage]);
  return (
    <QueryClientProvider key={runtimeKey} client={runtime.queryClient}>
      <GatewayClientProvider client={runtime.api}>
        <GatewayRuntimeEnvironmentProvider value={environment}>{children}</GatewayRuntimeEnvironmentProvider>
      </GatewayClientProvider>
    </QueryClientProvider>
  );
}
