import { CompatibilityNotice } from "./CompatibilityNotice";
import { compatibilityRequired, observeApiVersion } from "./compatibility";
import { Button, Center, MantineProvider, Stack, Text } from "@mantine/core";
import type { QueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { refreshQueuedInputs } from "../queuedInputs/cache";
import { refreshAutomationRuns } from "../automations/runsCache";
import { refreshUnreadBadge } from "../notifications/unreadBadge";
import { refreshNotificationQueries } from "../notifications/cache";
import { refreshAccountQueries } from "../account/cache";
import { refreshApprovalSnapshot } from "../approvals/cache";
import { refreshProjectState } from "../projects/cache";
import { refreshThreadSettings } from "../composer/threadSettingsCache";
import { PwaLifecycle } from "../pwa/PwaLifecycle";
import { currentKodexRoute, isThemeWorkbenchRoute, replaceKodexRoute } from "../shell/browserRouting";
import { getCapabilities, getProject, getThreadDetail } from "./client";
import { createInstanceStorage, type InstanceStorage } from "./instanceStorage";
import { queryKeys } from "./queryKeys";
import { refreshNativeConfig } from "./nativeConfigCache";
import { refreshAppSurfaceSessions } from "../appSurfaces/cache";
import { refreshThreadSubagents } from "../threads/subagentsCache";

const InstanceStorageContext = createContext<InstanceStorage | null>(null);
const InstanceConnectionContext = createContext<{
  beforeConnect: () => Promise<boolean>;
  onConnected: () => void;
} | undefined>(undefined);

export function useGatewayInstanceStorage(): InstanceStorage | null {
  return useContext(InstanceStorageContext);
}

export function useGatewayInstanceValidation() {
  return useContext(InstanceConnectionContext)?.beforeConnect;
}

export function useGatewayStreamConnected() {
  return useContext(InstanceConnectionContext)?.onConnected;
}

type GatewayInstanceBoundaryProps = { children: ReactNode; queryClient: QueryClient };

export function GatewayInstanceBoundary(props: GatewayInstanceBoundaryProps) {
  return isThemeWorkbenchRoute() ? props.children : <GatewayInstanceGate {...props} />;
}

function GatewayInstanceGate({ children, queryClient }: GatewayInstanceBoundaryProps) {
  const [instance, setInstance] = useState<{ id: string; storage: InstanceStorage | null } | null>(null);
  const [error, setError] = useState<"connection" | "link" | null>(null);
  const instanceIdRef = useRef<string | null>(null);
  const requestRef = useRef<{ controller: AbortController; promise: Promise<string | null> } | null>(null);

  const checkIdentity = useCallback((force = false): Promise<string | null> => {
    if (requestRef.current && !force) return requestRef.current.promise;
    requestRef.current?.controller.abort();
    const request = new AbortController();
    const promise = (async () => {
      let failure: "connection" | "link" = "connection";
      try {
        const capabilities = await getCapabilities(request.signal);
        if (request.signal.aborted) return null;
        observeApiVersion(capabilities.gateway.apiVersion);
        if (compatibilityRequired()) return null;
        const id = capabilities.gateway.instanceId;
        if (typeof id !== "string" || !id.trim()) {
          throw new Error("Gateway did not provide an instance identity.");
        }
        if (instanceIdRef.current === null) {
          failure = "link";
          await validateInitialRoute(request.signal);
          if (request.signal.aborted) return null;
        }
        if (instanceIdRef.current !== id) {
          await queryClient.cancelQueries();
          if (request.signal.aborted) return null;
          queryClient.clear();
          if (instanceIdRef.current !== null) {
            const route = currentKodexRoute();
            if (route.threadId || route.projectId) {
              replaceKodexRoute({ panel: route.panel, threadId: null });
            }
          }
          instanceIdRef.current = id;
          setInstance({ id, storage: createInstanceStorage(id) });
        } else if (force) {
          // Foreground checks also recover missed account changes while a stream stays open.
          void refreshAccountQueries(queryClient, { cancelInFlight: true });
          void refreshApprovalSnapshot(queryClient);
          void refreshProjectState(queryClient);
          void refreshThreadSettings(queryClient);
          void refreshNativeConfig(queryClient);
          void refreshAppSurfaceSessions(queryClient);
          void refreshThreadSubagents(queryClient);
          void refreshUnreadBadge(queryClient);
          void refreshNotificationQueries(queryClient);
          void refreshQueuedInputs(queryClient);
          void refreshAutomationRuns(queryClient);
        }
        queryClient.setQueryData(queryKeys.capabilities, capabilities);
        setError(null);
        return id;
      } catch {
        if (!request.signal.aborted) setError(failure);
        return null;
      } finally {
        if (requestRef.current?.controller === request) requestRef.current = null;
      }
    })();
    requestRef.current = { controller: request, promise };
    return promise;
  }, [queryClient]);

  const confirmedId = instance?.id;
  const validateInstance = useCallback(async () => (await checkIdentity()) === confirmedId, [checkIdentity, confirmedId]);
  const handleStreamConnected = useCallback(() => {
    if (confirmedId && instanceIdRef.current === confirmedId) {
      void refreshAccountQueries(queryClient, { cancelInFlight: true });
      void refreshApprovalSnapshot(queryClient);
      void refreshProjectState(queryClient);
      void refreshThreadSettings(queryClient);
      void refreshNativeConfig(queryClient);
      void refreshAppSurfaceSessions(queryClient);
      void refreshThreadSubagents(queryClient);
      void refreshUnreadBadge(queryClient);
      void refreshNotificationQueries(queryClient);
      void refreshQueuedInputs(queryClient);
      void refreshAutomationRuns(queryClient);
    }
  }, [confirmedId, queryClient]);
  const connection = useMemo(() => ({ beforeConnect: validateInstance, onConnected: handleStreamConnected }), [handleStreamConnected, validateInstance]);

  useEffect(() => {
    void checkIdentity();
    const recheck = () => { void checkIdentity(true); };
    const recheckInitialRoute = () => { if (instanceIdRef.current === null) recheck(); };
    window.addEventListener("online", recheck);
    window.addEventListener("pageshow", recheck);
    window.addEventListener("focus", recheck);
    window.addEventListener("popstate", recheckInitialRoute);
    return () => {
      requestRef.current?.controller.abort();
      requestRef.current = null;
      window.removeEventListener("online", recheck);
      window.removeEventListener("pageshow", recheck);
      window.removeEventListener("focus", recheck);
      window.removeEventListener("popstate", recheckInitialRoute);
    };
  }, [checkIdentity]);

  if (instance) {
    return (
      <InstanceStorageContext.Provider key={instance.id} value={instance.storage}>
        <InstanceConnectionContext.Provider value={connection}>{children}</InstanceConnectionContext.Provider>
      </InstanceStorageContext.Provider>
    );
  }

  // A stale bundle must be able to update before capabilities succeeds.
  // The ready App takes over the shared PWA lifecycle after bootstrap.
  return (
    <MantineProvider>
      <PwaLifecycle />
      <CompatibilityNotice />
      <Center mih="100dvh" p="md">
        <Stack align="center">
          <Text role={error ? "alert" : "status"}>
            {error === "link" ? "This link could not be opened in this Kodex instance."
              : error ? "Unable to connect to this Kodex instance." : "Connecting to Kodex…"}
          </Text>
          {error ? <Button onClick={() => { setError(null); void checkIdentity(true); }}>Retry</Button> : null}
          {error === "link" ? (
            <Button variant="subtle" onClick={() => {
              replaceKodexRoute({ panel: currentKodexRoute().panel, threadId: null });
              setError(null);
              void checkIdentity(true);
            }}>Open workspace</Button>
          ) : null}
        </Stack>
      </Center>
    </MantineProvider>
  );
}

async function validateInitialRoute(signal: AbortSignal) {
  const route = currentKodexRoute();
  if (route.threadId) {
    const response = await getThreadDetail(route.threadId, signal);
    if (response.thread.id !== route.threadId) throw new Error("Thread ID did not match the link.");
  } else if (route.projectId) {
    const project = await getProject(route.projectId, signal);
    if (project.id !== route.projectId) throw new Error("Project ID did not match the link.");
  }
  const current = currentKodexRoute();
  if (current.threadId !== route.threadId || current.projectId !== route.projectId) {
    throw new Error("The link changed while it was being checked.");
  }
}
