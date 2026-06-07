import { usageLimitSnapshotFromEvent } from "../account/rateLimits";
import type { EventEnvelope, QueuedInput, RateLimitSnapshot } from "../api/client";
import { isApprovalEvent } from "../approvals/state";
import {
  threadNotificationsUpdateFromEvent,
  threadPinUpdateFromEvent,
  threadSubagentDiscoveryEventFromEvent,
  threadUpsertFromEvent,
  type ThreadSubagentDiscoveryEvent,
  type ThreadUpsert,
} from "../threads/events";

export type LiveEventRouteHandlers = {
  applyAutomationStreamEvent: (event: EventEnvelope) => void;
  applyQueuedInputUpsert: (row: QueuedInput) => void;
  applyQueuedInputDeleted: (threadId: string, id: string) => void;
  applyThreadPinState: (threadId: string, pinnedAt: string | null) => void;
  applyThreadUpsert: (update: ThreadUpsert) => void;
  applyThreadMetadataEvent: (event: EventEnvelope) => void;
  applyCompletedAgentTurnEvent: (event: EventEnvelope) => void;
  applyThreadReadStateEvent: (event: EventEnvelope) => void;
  applyThreadNotificationsState: (threadId: string, notificationsEnabled: boolean) => void;
  refreshSidebarThreadsForLiveEvent: (event: EventEnvelope) => void;
  applySubagentDiscoveryEvent: (event: ThreadSubagentDiscoveryEvent) => void;
  applyUsageLimitSnapshot: (snapshot: RateLimitSnapshot) => void;
  applyApprovalEvent: (event: EventEnvelope) => void;
  applyAppSurfaceEvent: (event: EventEnvelope) => void;
  applySkillsChangedEvent: () => void;
  applyMcpLifecycleEvent: (event: EventEnvelope) => void;
};

export type SelectedThreadLiveEventRouteHandlers = Omit<
  LiveEventRouteHandlers,
  "applyUsageLimitSnapshot" | "applyApprovalEvent" | "applySkillsChangedEvent" | "applyMcpLifecycleEvent"
>;

export function routeGlobalLiveEvent(event: EventEnvelope, handlers: LiveEventRouteHandlers) {
  routeSharedLiveEvent(event, handlers);
  const usageLimitSnapshot = usageLimitSnapshotFromEvent(event);
  if (usageLimitSnapshot) {
    handlers.applyUsageLimitSnapshot(usageLimitSnapshot);
  }
  if (isApprovalEvent(event)) {
    handlers.applyApprovalEvent(event);
  }
  if (event.kind === "skills.changed") {
    handlers.applySkillsChangedEvent();
  }
  if (isMcpLifecycleEvent(event)) {
    handlers.applyMcpLifecycleEvent(event);
  }
}

export function routeSelectedThreadLiveEvent(event: EventEnvelope, handlers: SelectedThreadLiveEventRouteHandlers) {
  routeSharedLiveEvent(event, handlers);
}

function routeSharedLiveEvent(event: EventEnvelope, handlers: SelectedThreadLiveEventRouteHandlers) {
  if (event.kind === "automation.item_upsert" || event.kind === "automation.item_deleted") {
    handlers.applyAutomationStreamEvent(event);
  }
  if (event.kind.startsWith("app_surface.")) {
    handlers.applyAppSurfaceEvent(event);
  }
  const queueUpsert = queuedInputUpsertFromEvent(event);
  if (queueUpsert) {
    handlers.applyQueuedInputUpsert(queueUpsert);
  }
  const queueDelete = queuedInputDeleteFromEvent(event);
  if (queueDelete) {
    handlers.applyQueuedInputDeleted(queueDelete.threadId, queueDelete.id);
  }
  const pinUpdate = threadPinUpdateFromEvent(event);
  if (pinUpdate) {
    handlers.applyThreadPinState(pinUpdate.threadId, pinUpdate.pinnedAt);
  }
  const threadUpsert = threadUpsertFromEvent(event);
  if (threadUpsert) {
    handlers.applyThreadUpsert(threadUpsert);
  }
  if (isThreadMetadataEvent(event)) {
    handlers.applyThreadMetadataEvent(event);
  }
  if (event.kind === "thread_view.patch") {
    handlers.applyCompletedAgentTurnEvent(event);
  }
  if (event.kind === "thread.read_updated") {
    handlers.applyThreadReadStateEvent(event);
  }
  const notificationsUpdate = threadNotificationsUpdateFromEvent(event);
  if (notificationsUpdate) {
    handlers.applyThreadNotificationsState(notificationsUpdate.threadId, notificationsUpdate.notificationsEnabled);
  }
  if (event.kind === "thread_view.patch" || event.kind === "timeline.thread_metadata") {
    handlers.refreshSidebarThreadsForLiveEvent(event);
  }
  const subagentDiscoveryEvent = threadSubagentDiscoveryEventFromEvent(event);
  if (subagentDiscoveryEvent) {
    handlers.applySubagentDiscoveryEvent(subagentDiscoveryEvent);
  }
}

function queuedInputUpsertFromEvent(event: EventEnvelope): QueuedInput | null {
  if (event.kind !== "turn_queue.item_upsert") {
    return null;
  }
  const row = event.payload as QueuedInput;
  return row?.id && row.threadId ? row : null;
}

function queuedInputDeleteFromEvent(event: EventEnvelope): { threadId: string; id: string } | null {
  if (event.kind !== "turn_queue.item_deleted") {
    return null;
  }
  const payload = event.payload as { id?: unknown; threadId?: unknown };
  const id = typeof payload.id === "string" ? payload.id : null;
  const threadId = typeof payload.threadId === "string" ? payload.threadId : event.threadId;
  return id && threadId ? { threadId, id } : null;
}

function isMcpLifecycleEvent(event: EventEnvelope): boolean {
  return (
    event.kind === "mcp.config_changed" ||
    event.kind === "mcp.server_status_updated" ||
    event.kind === "mcp.oauth_login_completed"
  );
}

function isThreadMetadataEvent(event: EventEnvelope): boolean {
  return (
    event.kind === "timeline.thread_metadata" ||
    event.kind === "thread_view.patch" ||
    event.kind === "thread.upserted" ||
    event.kind === "thread.pin_updated" ||
    event.kind === "thread.notifications_updated" ||
    event.kind === "thread.read_updated" ||
    event.codexMethod === "thread/name/updated"
  );
}
