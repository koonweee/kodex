import type { QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { applyAccountEvent } from "../account/cache";
import { applyThreadSettingsEvent } from "../composer/threadSettingsCache";
import type { EventEnvelope, QueuedInput, RateLimitSnapshot } from "../api/client";
import { applyMcpLifecycleEvent } from "../api/mcpCache";
import { queryKeys } from "../api/queryKeys";
import { applyThreadSectionsEvent } from "../sections/cache";
import { applyProjectEvent } from "../projects/cache";
import { applyAppSurfaceEvent } from "../appSurfaces/cache";
import { applyApprovalInvalidation } from "../approvals/cache";
import { applyCachedAutomationEvent } from "../automations/cache";
import type { ThreadSubagentDiscoveryEvent, ThreadUpsert } from "../threads/events";
import type { LiveEventRouteHandlers } from "./liveRouting";

export function useLiveEventHandlers({
  applyCompletedAgentTurnEvent,
  applyQueuedInputDeleted,
  applyQueuedInputUpsert,
  applySubagentDiscoveryEvent,
  applyThreadMetadataEvent,
  applyThreadNotificationsState,
  applyThreadReadStateEvent,
  applyThreadUpsert,
  applyUsageLimitSnapshot,
  queryClient,
  refreshSidebarThreadsForLiveEvent,
  setSkillsInvalidationGeneration,
}: {
  applyCompletedAgentTurnEvent: (event: EventEnvelope) => void;
  applyQueuedInputDeleted: (threadId: string, id: string) => void;
  applyQueuedInputUpsert: (row: QueuedInput) => void;
  applySubagentDiscoveryEvent: (event: ThreadSubagentDiscoveryEvent) => void;
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

    function applyMcpLifecycleStreamEvent(event: EventEnvelope) {
      applyMcpLifecycleEvent(queryClient, event);
    }

    function applyAppSurfaceStreamEvent(event: EventEnvelope) {
      applyAppSurfaceEvent(queryClient, event);
    }

    const liveRouteHandlers: LiveEventRouteHandlers = {
      applyAccountEvent: (event) => applyAccountEvent(queryClient, event),
      applyThreadSectionsEvent: (event) => applyThreadSectionsEvent(queryClient, event),
      applyProjectEvent: (event) => applyProjectEvent(queryClient, event),
      applyThreadSettingsEvent: (event) => applyThreadSettingsEvent(queryClient, event),
      applyAutomationStreamEvent,
      applyQueuedInputUpsert,
      applyQueuedInputDeleted,
      applyThreadUpsert,
      applyThreadMetadataEvent,
      applyCompletedAgentTurnEvent,
      applyThreadReadStateEvent,
      applyThreadNotificationsState,
      refreshSidebarThreadsForLiveEvent,
      applySubagentDiscoveryEvent,
      applyUsageLimitSnapshot,
      applyApprovalEvent: (event) => applyApprovalInvalidation(queryClient, event),
      applyAppSurfaceEvent: applyAppSurfaceStreamEvent,
      applySkillsChangedEvent,
      applyMcpLifecycleEvent: applyMcpLifecycleStreamEvent,
    };

    return {
      liveRouteHandlers,
    };
  }, [
    applyCompletedAgentTurnEvent,
    applyQueuedInputDeleted,
    applyQueuedInputUpsert,
    applySubagentDiscoveryEvent,
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
