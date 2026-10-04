import { Button, Center, MantineProvider, Stack, Text } from "@mantine/core";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

import { PwaLifecycle } from "../pwa/PwaLifecycle";
import { currentKodexRoute, isThemeWorkbenchRoute, replaceKodexRoute } from "../shell/browserRouting";
import { getCapabilities } from "./client";
import { createInstanceStorage, type InstanceStorage } from "./instanceStorage";
import { queryKeys } from "./queryKeys";

const InstanceStorageContext = createContext<InstanceStorage | null>(null);

export function useGatewayInstanceStorage(): InstanceStorage | null {
  return useContext(InstanceStorageContext);
}

type GatewayInstanceBoundaryProps = { children: ReactNode; queryClient: QueryClient };

export function GatewayInstanceBoundary(props: GatewayInstanceBoundaryProps) {
  return isThemeWorkbenchRoute() ? props.children : <GatewayInstanceGate {...props} />;
}

function GatewayInstanceGate({ children, queryClient }: GatewayInstanceBoundaryProps) {
  const [instance, setInstance] = useState<{ id: string; storage: InstanceStorage | null } | null>(null);
  const [error, setError] = useState(false);
  const instanceIdRef = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const checkIdentity = useCallback(async () => {
    requestRef.current?.abort();
    const request = new AbortController();
    requestRef.current = request;
    try {
      const capabilities = await getCapabilities(request.signal);
      if (request.signal.aborted) return;
      const id = capabilities.gateway.instanceId;
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("Gateway did not provide an instance identity.");
      }
      if (instanceIdRef.current !== id) {
        await queryClient.cancelQueries();
        if (request.signal.aborted) return;
        queryClient.clear();
        if (instanceIdRef.current !== null) {
          const route = currentKodexRoute();
          if (route.threadId || route.projectId) {
            replaceKodexRoute({ panel: route.panel, threadId: null });
          }
        }
        instanceIdRef.current = id;
        setInstance({ id, storage: createInstanceStorage(id) });
      }
      queryClient.setQueryData(queryKeys.capabilities, capabilities);
      setError(false);
    } catch {
      if (!request.signal.aborted) setError(true);
    }
  }, [queryClient]);

  useEffect(() => {
    void checkIdentity();
    const recheck = () => { void checkIdentity(); };
    window.addEventListener("online", recheck);
    window.addEventListener("pageshow", recheck);
    window.addEventListener("focus", recheck);
    return () => {
      requestRef.current?.abort();
      window.removeEventListener("online", recheck);
      window.removeEventListener("pageshow", recheck);
      window.removeEventListener("focus", recheck);
    };
  }, [checkIdentity]);

  if (instance) {
    return (
      <InstanceStorageContext.Provider key={instance.id} value={instance.storage}>
        {children}
      </InstanceStorageContext.Provider>
    );
  }

  // A stale bundle must be able to update before capabilities succeeds.
  // The ready App takes over the shared PWA lifecycle after bootstrap.
  return (
    <MantineProvider>
      <PwaLifecycle />
      <Center mih="100dvh" p="md">
        <Stack align="center">
          <Text role={error ? "alert" : "status"}>
            {error ? "Unable to connect to this Kodex instance." : "Connecting to Kodex…"}
          </Text>
          {error ? <Button onClick={() => { setError(false); void checkIdentity(); }}>Retry</Button> : null}
        </Stack>
      </Center>
    </MantineProvider>
  );
}
