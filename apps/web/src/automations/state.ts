import type { Automation, EventEnvelope } from "../api/client";

export function upsertAutomation(automations: Automation[], automation: Automation): Automation[] {
  const withoutAutomation = automations.filter((item) => item.id !== automation.id);
  return [automation, ...withoutAutomation].sort(compareAutomations);
}

export function deleteAutomationById(automations: Automation[], automationId: string): Automation[] {
  return automations.filter((automation) => automation.id !== automationId);
}

export function applyAutomationEvent(automations: Automation[], event: EventEnvelope): Automation[] {
  if (event.kind === "automation.item_upsert") {
    const automation = automationFromPayload(event.payload);
    return automation ? upsertAutomation(automations, automation) : automations;
  }
  if (event.kind === "automation.item_deleted") {
    const id = automationDeleteIdFromPayload(event.payload);
    return id ? deleteAutomationById(automations, id) : automations;
  }
  return automations;
}

export function mergeAutomationSnapshot(
  current: Automation[],
  snapshot: Automation[],
  loadRevision: number,
  currentRevision: number,
): Automation[] {
  return currentRevision === loadRevision ? [...snapshot].sort(compareAutomations) : current;
}

function automationFromPayload(payload: unknown): Automation | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Partial<Automation>;
  return typeof candidate.id === "string" && typeof candidate.name === "string" ? (candidate as Automation) : null;
}

function automationDeleteIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const id = (payload as { id?: unknown }).id;
  return typeof id === "string" ? id : null;
}

function compareAutomations(left: Automation, right: Automation): number {
  const createdDelta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
  return createdDelta === 0 ? left.id.localeCompare(right.id) : createdDelta;
}

