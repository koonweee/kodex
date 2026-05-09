import type { QueryClient } from "@tanstack/react-query";

import type { Automation, EventEnvelope } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { applyAutomationEvent, deleteAutomationById, upsertAutomation } from "./state";

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
  queryClient.setQueryData<string[]>(queryKeys.automationTombstones, (current) =>
    (current ?? []).filter((id) => id !== automation.id),
  );
  queryClient.setQueryData<Automation[]>(queryKeys.automations, (current) =>
    upsertAutomation(current ?? [], automation),
  );
}

export function deleteCachedAutomation(queryClient: QueryClient, automationId: string) {
  queryClient.setQueryData<string[]>(queryKeys.automationTombstones, (current) =>
    current?.includes(automationId) ? current : [...(current ?? []), automationId],
  );
  queryClient.setQueryData<Automation[]>(queryKeys.automations, (current) =>
    current ? deleteAutomationById(current, automationId) : current,
  );
}

export function applyCachedAutomationEvent(queryClient: QueryClient, event: EventEnvelope) {
  if (event.kind === "automation.item_upsert") {
    queryClient.setQueryData<Automation[]>(queryKeys.automations, (current) =>
      applyAutomationEvent(current ?? [], event),
    );
    return;
  }
  if (event.kind === "automation.item_deleted") {
    const id = automationDeleteIdFromPayload(event.payload);
    if (id) {
      deleteCachedAutomation(queryClient, id);
    }
  }
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
