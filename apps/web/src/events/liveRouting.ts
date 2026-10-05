import { usageLimitSnapshotFromEvent } from "../account/rateLimits";
import type { EventEnvelope, RateLimitSnapshot } from "../api/client";
import { isApprovalEvent } from "../approvals/state";
import {
  threadNotificationsUpdateFromEvent,
  threadUpsertFromEvent,
  type ThreadUpsert,
} from "../threads/events";

export type LiveEventRouteHandlers = {
  applyUnreadBadgeEvent: (event: EventEnvelope) => void;
  applyAccountEvent: (event: EventEnvelope) => void;
  applyProjectEvent: (event: EventEnvelope) => void;
  applyThreadSettingsEvent: (event: EventEnvelope) => void;
  applyAutomationStreamEvent: (event: EventEnvelope) => void;
  applyQueueEvent: (event: EventEnvelope) => void;
  applyThreadPinsEvent: (event: EventEnvelope) => void;
  applyThreadUpsert: (update: ThreadUpsert) => void;
  applyThreadMetadataEvent: (event: EventEnvelope) => void;
  applyThreadReadStateEvent: (event: EventEnvelope) => void;
  applyThreadNotificationsState: (threadId: string, notificationsEnabled: boolean) => void;
  refreshSidebarThreadsForLiveEvent: (event: EventEnvelope) => void;
  applySubagentsEvent: (event: EventEnvelope) => void;
  applyUsageLimitSnapshot: (snapshot: RateLimitSnapshot) => void;
  applyApprovalEvent: (event: EventEnvelope) => void;
  applyAppSurfaceEvent: (event: EventEnvelope) => void;
  applySkillsChangedEvent: () => void;
  applyNativeConfigEvent: (event: EventEnvelope) => void;
};

export function routeGlobalLiveEvent(event: EventEnvelope, handlers: LiveEventRouteHandlers) {
  routeSharedLiveEvent(event, handlers);
  handlers.applyUnreadBadgeEvent(event);
  if (event.kind === "thread.subagents_changed") handlers.applySubagentsEvent(event);
  if (event.kind === "thread.pins_updated") handlers.applyThreadPinsEvent(event);
  if (event.kind === "project.changed" || event.kind === "thread.project_updated") {
    handlers.applyProjectEvent(event);
  }
  if (event.kind === "thread.settings_updated" || event.kind === "thread_view.patch") {
    handlers.applyThreadSettingsEvent(event);
  }
  if (event.kind === "account.updated" || event.kind === "account.login_completed") {
    handlers.applyAccountEvent(event);
  }
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
  if (isNativeConfigEvent(event)) {
    handlers.applyNativeConfigEvent(event);
  }
}

function routeSharedLiveEvent(event: EventEnvelope, handlers: LiveEventRouteHandlers) {
  if (event.kind === "automation.item_upsert" || event.kind === "automation.item_deleted" || event.kind === "automation.run_updated") {
    handlers.applyAutomationStreamEvent(event);
  }
  if (event.kind.startsWith("app_surface.")) {
    handlers.applyAppSurfaceEvent(event);
  }
  if (event.kind === "turn_queue.changed" || event.kind === "turn_queue.transfer_changed") handlers.applyQueueEvent(event);
  const threadUpsert = threadUpsertFromEvent(event);
  if (threadUpsert) {
    handlers.applyThreadUpsert(threadUpsert);
  }
  if (isThreadMetadataEvent(event)) {
    handlers.applyThreadMetadataEvent(event);
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
}

function isNativeConfigEvent(event: EventEnvelope): boolean {
  return (
    event.kind === "config.changed" ||
    event.kind === "mcp.server_status_updated" ||
    event.kind === "mcp.oauth_login_completed"
  );
}

function isThreadMetadataEvent(event: EventEnvelope): boolean {
  return (
    event.kind === "timeline.thread_metadata" ||
    event.kind === "thread_view.patch" ||
    event.kind === "thread.upserted" ||
    event.kind === "thread.notifications_updated" ||
    event.kind === "thread.read_updated" ||
    event.codexMethod === "thread/name/updated"
  );
}
