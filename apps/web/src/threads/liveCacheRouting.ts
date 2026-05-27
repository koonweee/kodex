import type { EventEnvelope, ThreadSummary } from "../api/client";
import { asRecord, stringValue } from "../shared/values";
import { threadHasDisplayTitle } from "./helpers";

export type SidebarThreadLocation =
  | { scope: "project"; projectId: string; thread: ThreadSummary }
  | { scope: "chat"; thread: ThreadSummary };

export type SidebarLiveCacheRoute =
  | { kind: "ignore" }
  | { kind: "invalidateAllThreadLists"; reason: "missingThreadMetadata" }
  | { kind: "invalidateKnownThreadList"; location: SidebarThreadLocation; reason: "missingDisplayTitle" };

export function sidebarLiveCacheRoute(event: EventEnvelope, location: SidebarThreadLocation | null): SidebarLiveCacheRoute {
  if (!event.threadId || !eventCanRefreshSidebarThread(event)) {
    return { kind: "ignore" };
  }
  if (!location) {
    return event.kind === "thread_view.patch"
      ? { kind: "invalidateAllThreadLists", reason: "missingThreadMetadata" }
      : { kind: "ignore" };
  }
  if (event.kind === "thread_view.patch" && !threadHasDisplayTitle(location.thread)) {
    return { kind: "invalidateKnownThreadList", location, reason: "missingDisplayTitle" };
  }
  return { kind: "ignore" };
}

export function eventCanAffectSubagentDiscovery(event: EventEnvelope): boolean {
  return event.kind === "thread_view.patch" && threadViewPatchContainsCollabAgent(event.payload);
}

function eventCanRefreshSidebarThread(event: EventEnvelope) {
  return event.kind === "thread_view.patch" || event.kind === "timeline.thread_metadata";
}

function threadViewPatchContainsCollabAgent(payload: unknown): boolean {
  const patch = asRecord(payload);
  return (
    arrayValue(patch.rows).some(timelineRowContainsCollabAgent) ||
    arrayValue(patch.upsertRows).some(timelineRowContainsCollabAgent)
  );
}

function timelineRowContainsCollabAgent(value: unknown): boolean {
  const row = asRecord(value);
  return (
    collabAgentTypeValue(row.kind) ||
    timelineItemLooksLikeCollabAgent(row.item) ||
    arrayValue(row.items).some(timelineItemLooksLikeCollabAgent) ||
    arrayValue(row.collapsedRows).some(timelineRowContainsCollabAgent)
  );
}

function timelineItemLooksLikeCollabAgent(value: unknown): boolean {
  const item = asRecord(value);
  const payload = asRecord(item.payload);
  const rawItem = asRecord(payload.item);
  const itemSnapshot = asRecord(payload.itemSnapshot);
  return (
    collabAgentTypeValue(item.itemType) ||
    collabAgentTypeValue(item.kind) ||
    collabAgentTypeValue(rawItem.type) ||
    collabAgentTypeValue(itemSnapshot.itemType)
  );
}

function collabAgentTypeValue(value: unknown): boolean {
  return stringValue(value)?.toLowerCase().replace(/[_-]/g, "").includes("collabagent") ?? false;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
