import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import type { Automation, AutomationCreateRequest, AutomationUpdateRequest, EventEnvelope } from "../api/client";
import type { CatalogExecutorSnapshot } from "../api/federatorClient";
import {
  ExecutorRuntimeBoundary,
  useAvailableExecutorIds,
  useExecutorConnection,
  useExecutorRuntimeAvailable,
  useExecutorRuntimes,
  useGatewayClient,
} from "../api/GatewayClientContext";
import { queryKeys } from "../api/queryKeys";
import { useFederatedCatalogContext } from "../federation/FederatedCatalogContext";
import { threadDisplayTitle } from "../threads/helpers";
import { useOptionalWorkspace } from "../workspace/WorkspaceProvider";
import {
  applyCachedAutomationEvent,
  automationRevision,
  deleteCachedAutomation,
  reconcileAutomationSnapshot,
  upsertCachedAutomation,
} from "./cache";
import { applyAutomationRunEvent } from "./runsCache";
import type { AutomationThreadOption } from "./threadOptions";

export type FederatedAutomationRow = {
  automation: Automation;
  available: boolean;
  executorId: string;
  executorName: string;
  instanceId: string;
  key: string;
};

export type FederatedAutomationsValue = {
  createAutomation: (executorId: string, instanceId: string, request: AutomationCreateRequest) => Promise<Automation>;
  deleteAutomation: (executorId: string, instanceId: string, automationId: string) => Promise<void>;
  executorChoices: Array<{ id: string; name: string }>;
  instanceIdsByExecutor: Record<string, string>;
  isLoading: boolean;
  pauseAutomation: (executorId: string, instanceId: string, automationId: string) => Promise<Automation>;
  preferredExecutorId: string | null;
  resumeAutomation: (executorId: string, instanceId: string, automationId: string) => Promise<Automation>;
  rows: FederatedAutomationRow[];
  sourceErrors: Array<{ executorId: string; executorName: string; message: string }>;
  threadOptionsByExecutor: Record<string, AutomationThreadOption[]>;
  updateAutomation: (executorId: string, instanceId: string, automationId: string, request: AutomationUpdateRequest) => Promise<Automation>;
};

type SourceState = {
  automations: Automation[];
  error: string | null;
  instanceId: string;
  loading: boolean;
};

export function FederatedAutomationsController({
  active,
  children,
  preferredExecutorId,
}: {
  active: boolean;
  children: (value: FederatedAutomationsValue) => ReactNode;
  preferredExecutorId: string | null;
}) {
  const federation = useFederatedCatalogContext();
  const runtimes = useExecutorRuntimes();
  const availableExecutorIds = useAvailableExecutorIds();
  const [sourceState, setSourceState] = useState<Record<string, SourceState>>({});
  const executors = useMemo(() => federation?.executors.flatMap((executor) => (
    runtimes?.get(executor.id) ? [{
      executorId: executor.id,
      executorName: executor.displayName,
      instanceId: runtimes.get(executor.id)!.connection.instanceId,
    }] : []
  )) ?? [], [federation?.executors, runtimes]);
  const available = availableExecutorIds ?? new Set(executors.map((executor) => executor.executorId));

  useEffect(() => {
    const known = new Map(executors.map((executor) => [executor.executorId, executor.instanceId]));
    setSourceState((current) => {
      const entries = Object.entries(current).filter(([executorId, state]) => known.get(executorId) === state.instanceId);
      return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
    });
  }, [executors]);

  const updateSource = useCallback((executorId: string, instanceId: string, update: Partial<SourceState>) => {
    if (runtimes?.get(executorId)?.connection.instanceId !== instanceId) return;
    setSourceState((current) => {
      const previous = current[executorId]?.instanceId === instanceId
        ? current[executorId]!
        : { automations: [], error: null, instanceId, loading: false };
      const next = { ...previous, ...update, instanceId };
      if (previous.automations === next.automations && previous.error === next.error && previous.loading === next.loading) return current;
      return { ...current, [executorId]: next };
    });
  }, [runtimes]);

  const runtimeFor = useCallback((executorId: string, instanceId: string) => {
    const runtime = runtimes?.get(executorId);
    if (!runtime) throw new Error("Automation executor is no longer registered.");
    if (runtime.connection.instanceId !== instanceId) throw new Error("Automation executor instance changed.");
    if (!available.has(executorId)) throw new Error("Executor unavailable.");
    return runtime;
  }, [available, runtimes]);
  const createAutomation = useCallback(async (executorId: string, instanceId: string, request: AutomationCreateRequest) => {
    const runtime = runtimeFor(executorId, instanceId);
    const automation = await runtime.api.createAutomation(request);
    upsertCachedAutomation(runtime.queryClient, automation);
    return automation;
  }, [runtimeFor]);
  const updateAutomation = useCallback(async (executorId: string, instanceId: string, automationId: string, request: AutomationUpdateRequest) => {
    const runtime = runtimeFor(executorId, instanceId);
    const automation = await runtime.api.updateAutomation(automationId, request);
    upsertCachedAutomation(runtime.queryClient, automation);
    return automation;
  }, [runtimeFor]);
  const pauseAutomation = useCallback(async (executorId: string, instanceId: string, automationId: string) => {
    const runtime = runtimeFor(executorId, instanceId);
    const automation = await runtime.api.pauseAutomation(automationId);
    upsertCachedAutomation(runtime.queryClient, automation);
    return automation;
  }, [runtimeFor]);
  const resumeAutomation = useCallback(async (executorId: string, instanceId: string, automationId: string) => {
    const runtime = runtimeFor(executorId, instanceId);
    const automation = await runtime.api.resumeAutomation(automationId);
    upsertCachedAutomation(runtime.queryClient, automation);
    return automation;
  }, [runtimeFor]);
  const deleteAutomation = useCallback(async (executorId: string, instanceId: string, automationId: string) => {
    const runtime = runtimeFor(executorId, instanceId);
    await runtime.api.deleteAutomation(automationId);
    deleteCachedAutomation(runtime.queryClient, automationId);
  }, [runtimeFor]);

  const rows = useMemo(() => executors.flatMap(({ executorId, executorName, instanceId }) => (
    (sourceState[executorId]?.instanceId === instanceId ? sourceState[executorId]!.automations : []).map((automation) => ({
      automation,
      available: available.has(executorId),
      executorId,
      executorName,
      instanceId,
      key: JSON.stringify([executorId, instanceId, automation.id]),
    }))
  )), [available, executors, sourceState]);
  const sourceErrors = useMemo(() => executors.flatMap(({ executorId, executorName }) => {
    const message = sourceState[executorId]?.error;
    return message ? [{ executorId, executorName, message }] : [];
  }), [executors, sourceState]);
  const executorChoices = useMemo(() => executors.flatMap(({ executorId, executorName }) => (
    available.has(executorId) ? [{ id: executorId, name: executorName }] : []
  )), [available, executors]);
  const instanceIdsByExecutor = useMemo(() => Object.fromEntries(
    executors.map(({ executorId, instanceId }) => [executorId, instanceId]),
  ), [executors]);
  const threadOptionsByExecutor = useMemo(() => federation?.catalog
    ? Object.fromEntries(federation.catalog.executors.map((executor) => [
      executor.executorId,
      catalogAutomationThreadOptions(executor.snapshot),
    ]))
    : {}, [federation?.catalog]);
  const selectedPreferredExecutorId = executorChoices.some((choice) => choice.id === preferredExecutorId)
    ? preferredExecutorId
    : executorChoices[0]?.id ?? null;
  const value = useMemo<FederatedAutomationsValue>(() => ({
    createAutomation,
    deleteAutomation,
    executorChoices,
    instanceIdsByExecutor,
    isLoading: active && executors.some(({ executorId }) => available.has(executorId) && (sourceState[executorId]?.loading ?? true)),
    pauseAutomation,
    preferredExecutorId: selectedPreferredExecutorId,
    resumeAutomation,
    rows,
    sourceErrors,
    threadOptionsByExecutor,
    updateAutomation,
  }), [
    active, available, createAutomation, deleteAutomation, executorChoices, executors, instanceIdsByExecutor, pauseAutomation,
    resumeAutomation, rows, selectedPreferredExecutorId, sourceErrors, sourceState, threadOptionsByExecutor, updateAutomation,
  ]);

  if (!federation || !runtimes) throw new Error("Federated automation context is missing.");
  return <>
    {executors.map(({ executorId, instanceId }) => (
      <ExecutorRuntimeBoundary executorId={executorId} key={`${executorId}:${instanceId}`} preserveChildrenWhenUnavailable showChildrenWhenUnavailable>
        <ExecutorAutomationSource active={active} onChange={updateSource} />
      </ExecutorRuntimeBoundary>
    ))}
    {children(value)}
  </>;
}

function catalogAutomationThreadOptions(snapshot: CatalogExecutorSnapshot["snapshot"]): AutomationThreadOption[] {
  const seen = new Set<string>();
  const options: AutomationThreadOption[] = [];
  const add = (thread: (typeof snapshot.chatThreads.threads)[number]) => {
    if (seen.has(thread.id)) return;
    seen.add(thread.id);
    options.push({ label: threadDisplayTitle({ ...thread, rawPayload: {} }), value: thread.id });
  };
  snapshot.pinnedThreads.threads.forEach(add);
  Object.values(snapshot.projectThreads).forEach((page) => page.threads.forEach(add));
  snapshot.chatThreads.threads.forEach(add);
  return options;
}

function ExecutorAutomationSource({ active, onChange }: {
  active: boolean;
  onChange: (executorId: string, instanceId: string, update: Partial<SourceState>) => void;
}) {
  const api = useGatewayClient();
  const available = useExecutorRuntimeAvailable();
  const connection = useExecutorConnection();
  const queryClient = useQueryClient();
  const workspace = useOptionalWorkspace();
  const executorId = connection?.executorId;
  const instanceId = connection?.instanceId;
  const query = useQuery({
    enabled: active && available,
    queryKey: queryKeys.automations,
    queryFn: async ({ signal }) => {
      const loadRevision = automationRevision(queryClient);
      const snapshot = await api.listAutomations(undefined, signal);
      signal.throwIfAborted();
      return reconcileAutomationSnapshot(queryClient, snapshot, loadRevision);
    },
  });
  const subscribeLiveEvent = workspace?.subscribeLiveEvent;

  useEffect(() => {
    if (!executorId || !instanceId) return;
    onChange(executorId, instanceId, {
      ...(query.data ? { automations: query.data } : {}),
      error: query.error ? query.error.message : null,
      loading: active && available && (query.isFetching || !query.data),
    });
  }, [active, available, executorId, instanceId, onChange, query.data, query.error, query.isFetching]);

  useEffect(() => {
    if (!active || !available || !executorId) return;
    const unsubscribe = subscribeLiveEvent?.(executorId, (event: EventEnvelope) => {
      routeFederatedAutomationEvent(queryClient, event);
    });
    return unsubscribe;
  }, [active, available, executorId, queryClient, subscribeLiveEvent]);
  return null;
}

export function routeFederatedAutomationEvent(queryClient: QueryClient, event: EventEnvelope) {
  applyCachedAutomationEvent(queryClient, event);
  applyAutomationRunEvent(queryClient, event);
}
