import type { QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { applyQueueEvent } from "../queuedInputs/cache";
import { applyAutomationRunEvent } from "../automations/runsCache";
import { applyUnreadBadgeEvent } from "../notifications/unreadBadge";
import { applyAccountEvent } from "../account/cache";
import { applyThreadSettingsEvent } from "../composer/threadSettingsCache";
import type { EventEnvelope, RateLimitSnapshot } from "../api/client";
import { applyNativeConfigEvent } from "../api/nativeConfigCache";
import { queryKeys } from "../api/queryKeys";
import { applyThreadPinsEvent } from "../threads/pinnedCache";
import { applyProjectEvent } from "../projects/cache";
import { applyAppSurfaceEvent } from "../appSurfaces/cache";
import { applyApprovalInvalidation } from "../approvals/cache";
import { applyCachedAutomationEvent } from "../automations/cache";
import type { ThreadUpsert } from "../threads/events";
import { applySubagentsEvent } from "../threads/subagentsCache";
import type { LiveEventRouteHandlers } from "./liveRouting";

export function useLiveEventHandlers({
  applyThreadMetadataEvent,
  applyThreadNotificationsState,
  applyThreadReadStateEvent,
  applyThreadUpsert,
  applyUsageLimitSnapshot,
  queryClient,
  refreshSidebarThreadsForLiveEvent,
  setSkillsInvalidationGeneration,
}: {
  applyThreadMetadataEvent: (event: EventEnvelope) => void;
  applyThreadNotificationsState: (threadId: string, notificationsEnabled: boolean) => void;
  applyThreadReadStateEvent: (event: EventEnvelope) => void;
  applyThreadUpsert: (update: ThreadUpsert) => void;
  applyUsageLimitSnapshot: (snapshot: RateLimitSnapshot) => void;
  queryClient: QueryClient;
  refreshSidebarThreadsForLiveEvent: (event: EventEnvelope) => void;
  setSkillsInvalidationGeneration: (updater: (current: number) => number) => void;
}) {
  return useMemo(() => {
    function applyAutomationStreamEvent(event: EventEnvelope) {
      applyAutomationRunEvent(queryClient, event);
      const automationQueryState = queryClient.getQueryState(queryKeys.automations);
      if (automationQueryState?.data === undefined && automationQueryState?.fetchStatus !== "fetching") {
        return;
      }
      applyCachedAutomationEvent(queryClient, event);
      if (automationQueryState.fetchStatus === "fetching") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.automations });
      }
    }

    function applySkillsChangedEvent() {
      setSkillsInvalidationGeneration((current) => current + 1);
    }

    function applyNativeConfigStreamEvent(event: EventEnvelope) {
      applyNativeConfigEvent(queryClient, event);
    }

    function applyAppSurfaceStreamEvent(event: EventEnvelope) {
      applyAppSurfaceEvent(queryClient, event);
    }

    const liveRouteHandlers: LiveEventRouteHandlers = {
      applyQueueEvent: (event) => applyQueueEvent(queryClient, event),
      applyUnreadBadgeEvent: (event) => applyUnreadBadgeEvent(queryClient, event),
      applyAccountEvent: (event) => applyAccountEvent(queryClient, event),
      applyThreadPinsEvent: (event) => applyThreadPinsEvent(queryClient, event),
      applyProjectEvent: (event) => applyProjectEvent(queryClient, event),
      applyThreadSettingsEvent: (event) => applyThreadSettingsEvent(queryClient, event),
      applyAutomationStreamEvent,
      applyThreadUpsert,
      applyThreadMetadataEvent,
      applyThreadReadStateEvent,
      applyThreadNotificationsState,
      refreshSidebarThreadsForLiveEvent,
      applySubagentsEvent: (event) => applySubagentsEvent(queryClient, event),
      applyUsageLimitSnapshot,
      applyApprovalEvent: (event) => applyApprovalInvalidation(queryClient, event),
      applyAppSurfaceEvent: applyAppSurfaceStreamEvent,
      applySkillsChangedEvent,
      applyNativeConfigEvent: applyNativeConfigStreamEvent,
    };

    return {
      liveRouteHandlers,
    };
  }, [
    applyThreadMetadataEvent,
    applyThreadNotificationsState,
    applyThreadReadStateEvent,
    applyThreadUpsert,
    applyUsageLimitSnapshot,
    queryClient,
    refreshSidebarThreadsForLiveEvent,
    setSkillsInvalidationGeneration,
  ]);
}
