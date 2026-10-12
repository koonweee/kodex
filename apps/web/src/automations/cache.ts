import type { QueryClient } from "@tanstack/react-query";

import type { Automation, EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { applyAutomationEvent, deleteAutomationById, upsertAutomation } from "./state";

type AutomationCacheOperation =
  | { automation: Automation; kind: "upsert"; revision: number }
  | { automationId: string; kind: "delete"; revision: number };

export function mergeAutomationData(
  current: Automation[] | undefined,
  snapshot: Automation[],
  deletedIds: string[] = [],
): Automation[] {
  const deleted = new Set(deletedIds);
  if (!current || current.length === 0) {
    return sortAutomations(snapshot.filter((automation) => !deleted.has(automation.id)));
  }
  const byId = new Map<string, Automation>();
  for (const automation of snapshot) {
    if (!deleted.has(automation.id)) {
      byId.set(automation.id, automation);
    }
  }
  for (const automation of current) {
    if (!deleted.has(automation.id)) {
      byId.set(automation.id, automation);
    }
  }
  return sortAutomations([...byId.values()]);
}

export function upsertCachedAutomation(queryClient: QueryClient, automation: Automation) {
  const revision = advanceAutomationRevision(queryClient);
  appendAutomationOperation(queryClient, { automation, kind: "upsert", revision });
  queryClient.setQueryData<string[]>(queryKeys.automationTombstones, (current) =>
    (current ?? []).filter((id) => id !== automation.id),
  );
  queryClient.setQueryData<Automation[]>(queryKeys.automations, (current) =>
    upsertAutomation(current ?? [], automation),
  );
}

export function deleteCachedAutomation(queryClient: QueryClient, automationId: string) {
  const revision = advanceAutomationRevision(queryClient);
  appendAutomationOperation(queryClient, { automationId, kind: "delete", revision });
  queryClient.setQueryData<string[]>(queryKeys.automationTombstones, (current) =>
    current?.includes(automationId) ? current : [...(current ?? []), automationId],
  );
  queryClient.setQueryData<Automation[]>(queryKeys.automations, (current) =>
    current ? deleteAutomationById(current, automationId) : current,
  );
}

export function automationRevision(queryClient: QueryClient): number {
  return queryClient.getQueryData<number>(queryKeys.automationRevision) ?? 0;
}

export function reconcileAutomationSnapshot(
  queryClient: QueryClient,
  snapshot: Automation[],
  loadRevision: number,
): Automation[] {
  const revision = automationRevision(queryClient);
  let reconciled = mergeAutomationData(undefined, snapshot);
  for (const operation of queryClient.getQueryData<AutomationCacheOperation[]>(queryKeys.automationOperations) ?? []) {
    if (operation.revision <= loadRevision) continue;
    reconciled = operation.kind === "upsert"
      ? upsertAutomation(reconciled, operation.automation)
      : deleteAutomationById(reconciled, operation.automationId);
  }
  queryClient.setQueryData<string[]>(queryKeys.automationTombstones, []);
  queryClient.setQueryData<AutomationCacheOperation[]>(queryKeys.automationOperations, (current) =>
    (current ?? []).filter((operation) => operation.revision > revision),
  );
  return reconciled;
}

function advanceAutomationRevision(queryClient: QueryClient): number {
  const revision = automationRevision(queryClient) + 1;
  queryClient.setQueryData<number>(queryKeys.automationRevision, revision);
  return revision;
}

function appendAutomationOperation(queryClient: QueryClient, operation: AutomationCacheOperation) {
  queryClient.setQueryData<AutomationCacheOperation[]>(queryKeys.automationOperations, (current) => [
    ...(current ?? []),
    operation,
  ]);
}

export function applyCachedAutomationEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind === "automation.item_upsert") {
    const current = queryClient.getQueryData<Automation[]>(queryKeys.automations) ?? [];
    const next = applyAutomationEvent(current, event);
    const automationId = automationUpsertIdFromPayload(event.payload);
    const automation = automationId ? next.find((item) => item.id === automationId) : undefined;
    if (automation) upsertCachedAutomation(queryClient, automation);
    return;
  }
  if (event.kind === "automation.item_deleted") {
    const id = automationDeleteIdFromPayload(event.payload);
    if (id) {
      deleteCachedAutomation(queryClient, id);
    }
  }
}

function automationUpsertIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function automationDeleteIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function sortAutomations(automations: Automation[]): Automation[] {
  return [...automations].sort((left, right) => {
    const createdDelta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    return createdDelta === 0 ? left.id.localeCompare(right.id) : createdDelta;
  });
}
