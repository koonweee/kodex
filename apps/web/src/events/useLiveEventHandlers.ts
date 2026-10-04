import type { QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { applyAccountEvent } from "../account/cache";
import type { Approval, EventEnvelope, QueuedInput, RateLimitSnapshot } from "../api/client";
import { applyMcpLifecycleEvent } from "../api/mcpCache";
import { queryKeys } from "../api/queryKeys";
import { applyAppSurfaceEvent } from "../appSurfaces/cache";
import { applyCachedAutomationEvent } from "../automations/cache";
import type { ThreadSubagentDiscoveryEvent, ThreadUpsert } from "../threads/events";
import { routeSelectedThreadLiveEvent, type LiveEventRouteHandlers } from "./liveRouting";

export function useLiveEventHandlers({
  applyApprovalEventWithTombstone,
  applyCompletedAgentTurnEvent,
  applyQueuedInputDeleted,
  applyQueuedInputUpsert,
  applySubagentDiscoveryEvent,
  applyThreadMetadataEvent,
  applyThreadNotificationsState,
  applyThreadPinState,
  applyThreadReadStateEvent,
  applyThreadUpsert,
  applyUsageLimitSnapshot,
  queryClient,
  refreshSidebarThreadsForLiveEvent,
  setApprovals,
  setSkillsInvalidationGeneration,
}: {
  applyApprovalEventWithTombstone: (current: Approval[], event: EventEnvelope) => Approval[];
  applyCompletedAgentTurnEvent: (event: EventEnvelope) => void;
  applyQueuedInputDeleted: (threadId: string, id: string) => void;
  applyQueuedInputUpsert: (row: QueuedInput) => void;
  applySubagentDiscoveryEvent: (event: ThreadSubagentDiscoveryEvent) => void;
  applyThreadMetadataEvent: (event: EventEnvelope) => void;
  applyThreadNotificationsState: (threadId: string, notificationsEnabled: boolean) => void;
  applyThreadPinState: (threadId: string, pinnedAt: string | null) => void;
  applyThreadReadStateEvent: (event: EventEnvelope) => void;
  applyThreadUpsert: (update: ThreadUpsert) => void;
  applyUsageLimitSnapshot: (snapshot: RateLimitSnapshot) => void;
  queryClient: QueryClient;
  refreshSidebarThreadsForLiveEvent: (event: EventEnvelope) => void;
  setApprovals: (updater: (current: Approval[]) => Approval[]) => void;
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

    function applyApprovalEvent(event: EventEnvelope) {
      setApprovals((current) => applyApprovalEventWithTombstone(current, event));
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
      applyAutomationStreamEvent,
      applyQueuedInputUpsert,
      applyQueuedInputDeleted,
      applyThreadPinState,
      applyThreadUpsert,
      applyThreadMetadataEvent,
      applyCompletedAgentTurnEvent,
      applyThreadReadStateEvent,
      applyThreadNotificationsState,
      refreshSidebarThreadsForLiveEvent,
      applySubagentDiscoveryEvent,
      applyUsageLimitSnapshot,
      applyApprovalEvent,
      applyAppSurfaceEvent: applyAppSurfaceStreamEvent,
      applySkillsChangedEvent,
      applyMcpLifecycleEvent: applyMcpLifecycleStreamEvent,
    };

    return {
      applySelectedThreadStreamEvent: (event: EventEnvelope) => routeSelectedThreadLiveEvent(event, liveRouteHandlers),
      liveRouteHandlers,
    };
  }, [
    applyApprovalEventWithTombstone,
    applyCompletedAgentTurnEvent,
    applyQueuedInputDeleted,
    applyQueuedInputUpsert,
    applySubagentDiscoveryEvent,
    applyThreadMetadataEvent,
    applyThreadNotificationsState,
    applyThreadPinState,
    applyThreadReadStateEvent,
    applyThreadUpsert,
    applyUsageLimitSnapshot,
    queryClient,
    refreshSidebarThreadsForLiveEvent,
    setApprovals,
    setSkillsInvalidationGeneration,
  ]);
}
