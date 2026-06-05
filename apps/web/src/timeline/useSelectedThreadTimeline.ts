import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from "react";

import type { Approval, EventEnvelope, ThreadSummary } from "../api/client";
import { getThreadDetail, getThreadTimelinePage } from "../api/client";
import { isApprovalEvent } from "../approvals/state";
import {
  recordLiveEvent,
  recordReducerBatch,
  recordSelectedThreadDeltaMiss,
  recordSelectedThreadSnapshotRefresh,
  type SelectedThreadDeltaMissRelation,
  type SelectedThreadSnapshotRefreshReason,
} from "../events/liveDiagnostics";
import { createEventStreamClient } from "../events/stream";
import { errorMessageFrom } from "../shared/values";
import { applyTimelineEventBatch, coalesceTimelineEventBatch } from "./batch";
import { idleTimelineEntry, type TimelineEntry } from "./entry";
import {
  applyTimelineHistoryWindow,
  applyTimelineSnapshot,
  applyLiveTimelineUpdate,
  canApplyThreadViewItemDelta,
  createTimelineState,
  setTimelineOlderHistoryLoading,
  type TimelineState,
} from "./reducer";
import {
  indexesForState,
  timelineRowKeysByItemId,
} from "./state";
import {
  isCanonicalThreadViewRenderEvent,
  isThreadViewQueueEvent,
  threadViewSummaryToThreadSummary,
} from "./threadViewEvents";
import {
  isTransientThreadSnapshotLoadError,
  MATERIALIZING_THREAD_SNAPSHOT_RETRY_MS,
} from "./snapshotRetry";
import { useTimelineEventQueue } from "./useTimelineEventQueue";

export type ThreadSyncNotice = {
  message: string;
  tone: "info" | "warning";
};

export function useSelectedThreadTimeline({
  isSelectedThreadSnapshotDeferred,
  onApprovalEvent,
  onError,
  onQueueEvent,
  onSelectedThreadEvent,
  onSnapshotThread,
  onSyncNotice,
  onThreadLoadFailed,
  selectedThreadId,
  setApprovals,
  setTimeline,
  setTimelineEntry,
}: {
  isSelectedThreadSnapshotDeferred: boolean;
  onApprovalEvent: (current: Approval[], event: EventEnvelope) => Approval[];
  onError: (error: unknown) => void;
  onQueueEvent: (event: EventEnvelope) => void;
  onSelectedThreadEvent: (event: EventEnvelope) => void;
  onSnapshotThread: (thread: ThreadSummary) => void;
  onSyncNotice?: (notice: ThreadSyncNotice | null) => void;
  onThreadLoadFailed?: (threadId: string, error: unknown) => void;
  selectedThreadId: string | null;
  setApprovals: Dispatch<SetStateAction<Approval[]>>;
  setTimeline: Dispatch<SetStateAction<TimelineState>>;
  setTimelineEntry: Dispatch<SetStateAction<TimelineEntry>>;
}) {
  const selectedThreadStreamToken = useRef(0);
  const olderHistoryRequest = useRef<{ threadId: string; cursor: string } | null>(null);
  const requestTimelineRefresh = useRef<((reason: SelectedThreadSnapshotRefreshReason) => void) | null>(null);
  const snapshotRefreshInFlight = useRef<{ threadId: string; streamToken: number } | null>(null);
  const latestCallbacks = useRef({
    onApprovalEvent,
    onError,
    onQueueEvent,
    onSelectedThreadEvent,
    onSnapshotThread,
    onSyncNotice,
    onThreadLoadFailed,
  });
  latestCallbacks.current = {
    onApprovalEvent,
    onError,
    onQueueEvent,
    onSelectedThreadEvent,
    onSnapshotThread,
    onSyncNotice,
    onThreadLoadFailed,
  };

  function clearEntry() {
    setTimelineEntry(idleTimelineEntry);
    setTimeline(createTimelineState());
  }

  function beginEntry(threadId: string) {
    setTimeline(createTimelineState());
    setTimelineEntry({ phase: "loadingSnapshot", threadId });
  }

  function markEntryStreaming(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? { phase: "streamingLive", threadId } : current));
  }

  function markEntryRefreshing(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? { phase: "refreshingSnapshot", threadId } : current));
  }

  function clearEntryForThread(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? { phase: "error", threadId } : current));
  }

  function reduceQueuedTimelineEvents(current: TimelineState, events: EventEnvelope[]) {
    if (events.length === 0) {
      return current;
    }
    const startedAt = typeof performance !== "undefined" ? performance.now() : 0;
    let shouldRefresh = false;
    let validationState = current;
    const coalescedEvents = coalesceTimelineEventBatch(events);
    for (let index = 0; index < coalescedEvents.length; index += 1) {
      const event = coalescedEvents[index];
      if (!canApplyThreadViewItemDelta(validationState, event)) {
        const target = deltaTargetFromEvent(event);
        recordSelectedThreadDeltaMiss({
          batchSize: coalescedEvents.length,
          itemId: target.itemId,
          relation: deltaMissRelation(coalescedEvents, index, target),
          refreshInFlight: snapshotRefreshInFlight.current?.threadId === selectedThreadId,
          seq: event.seq,
          state: deltaMissStateRelation(validationState, target),
          threadId: target.threadId,
          turnId: target.turnId,
        });
        shouldRefresh = true;
        break;
      }
      validationState = applyLiveTimelineUpdate(validationState, event);
    }
    const next = applyTimelineEventBatch(current, coalescedEvents);
    const finishedAt = typeof performance !== "undefined" ? performance.now() : startedAt;
    recordReducerBatch(events.length, finishedAt - startedAt);
    if (shouldRefresh) {
      requestTimelineRefresh.current?.("deltaMiss");
    }
    return next;
  }

  const { cancelQueuedTimelineEvents, enqueueTimelineEvent } = useTimelineEventQueue({
    reduceEvents: reduceQueuedTimelineEvents,
    setTimeline,
  });

  const loadOlderHistory = useCallback(() => {
    const threadId = selectedThreadId;
    if (!threadId) {
      return;
    }
    let cursor: string | null = null;
    let shouldLoad = false;
    setTimeline((current) => {
      if (!current.hasOlderHistory || current.isLoadingOlderHistory || !current.olderCursor) {
        return current;
      }
      if (
        olderHistoryRequest.current?.threadId === threadId &&
        olderHistoryRequest.current.cursor === current.olderCursor
      ) {
        return current;
      }
      cursor = current.olderCursor;
      shouldLoad = true;
      olderHistoryRequest.current = { threadId, cursor };
      return setTimelineOlderHistoryLoading(current, true);
    });
    if (!shouldLoad || !cursor) {
      return;
    }

    void getThreadTimelinePage(threadId, { cursor })
      .then((snapshot) => {
        if (
          olderHistoryRequest.current?.threadId !== threadId ||
          olderHistoryRequest.current.cursor !== cursor
        ) {
          return;
        }
        olderHistoryRequest.current = null;
        setTimeline((current) => applyTimelineHistoryWindow(current, snapshot));
        latestCallbacks.current.onSnapshotThread(threadViewSummaryToThreadSummary(snapshot.thread));
      })
      .catch((error) => {
        if (
          olderHistoryRequest.current?.threadId === threadId &&
          olderHistoryRequest.current.cursor === cursor
        ) {
          olderHistoryRequest.current = null;
        }
        setTimeline((current) => setTimelineOlderHistoryLoading(current, false));
        latestCallbacks.current.onError(error);
      });
  }, [selectedThreadId, setTimeline]);

  useEffect(() => {
    if (!selectedThreadId) {
      selectedThreadStreamToken.current += 1;
      olderHistoryRequest.current = null;
      cancelQueuedTimelineEvents();
      latestCallbacks.current.onSyncNotice?.(null);
      clearEntry();
      return;
    }

    const threadId = selectedThreadId;
    if (isSelectedThreadSnapshotDeferred) {
      selectedThreadStreamToken.current += 1;
      cancelQueuedTimelineEvents();
      latestCallbacks.current.onSyncNotice?.(null);
      markEntryStreaming(threadId);
      return;
    }

    let cancelled = false;
    let closeStream: (() => void) | null = null;
    let materializingThreadRetry: ReturnType<typeof setTimeout> | null = null;
    const streamToken = selectedThreadStreamToken.current + 1;
    selectedThreadStreamToken.current = streamToken;

    function setSyncNotice(notice: ThreadSyncNotice | null) {
      latestCallbacks.current.onSyncNotice?.(notice);
    }

    async function refreshSnapshot(
      phase: "loadingSnapshot" | "refreshingSnapshot",
      reason: SelectedThreadSnapshotRefreshReason,
    ) {
      if (snapshotRefreshInFlight.current?.threadId === threadId) {
        return false;
      }
      snapshotRefreshInFlight.current = { threadId, streamToken };
      if (phase === "refreshingSnapshot") {
        markEntryRefreshing(threadId);
      }
      recordSelectedThreadSnapshotRefresh(reason);
      try {
        const snapshot = await getThreadDetail(threadId);
        if (cancelled || selectedThreadStreamToken.current !== streamToken) {
          return false;
        }
        setTimeline((current) => applyTimelineSnapshot(current, snapshot));
        latestCallbacks.current.onSnapshotThread(threadViewSummaryToThreadSummary(snapshot.thread));
        setSyncNotice(null);
        markEntryStreaming(threadId);
        return snapshot.timeline?.viewRevision ?? 0;
      } finally {
        if (
          snapshotRefreshInFlight.current?.threadId === threadId &&
          snapshotRefreshInFlight.current.streamToken === streamToken
        ) {
          snapshotRefreshInFlight.current = null;
        }
      }
    }

    const refetchSnapshot = (reason: SelectedThreadSnapshotRefreshReason) => {
      cancelQueuedTimelineEvents();
      if (reason === "streamReconnect") {
        setSyncNotice({
          message: "Selected thread stream disconnected. Reconnecting and retrying thread refresh.",
          tone: "warning",
        });
      }
      void refreshSnapshot("refreshingSnapshot", reason).catch((error) => {
        if (cancelled) {
          return;
        }
        setSyncNotice({
          message:
            reason === "streamReconnect"
              ? `Selected thread stream disconnected. Reconnecting and retrying thread refresh: ${errorMessageFrom(error)}`
              : reason === "deltaMiss"
                ? `Selected thread delta could not be applied. Retrying thread refresh: ${errorMessageFrom(error)}`
              : `Selected thread refresh failed. Retrying on the next gateway update: ${errorMessageFrom(error)}`,
          tone: "warning",
        });
      });
    };
    requestTimelineRefresh.current = refetchSnapshot;

    const connectSelectedThreadStream = (cursor: number) => {
      if (closeStream) {
        return;
      }
      const client = createEventStreamClient({
        cursor,
        threadId,
        onStatusChange: (status) => {
          if (status === "reconnecting" && selectedThreadStreamToken.current === streamToken) {
            refetchSnapshot("streamReconnect");
          }
        },
        onEvent: (event) => {
          recordLiveEvent("selected", event);
          if (selectedThreadStreamToken.current !== streamToken) {
            return;
          }
          if (event.threadId && event.threadId !== threadId) {
            return;
          }
          latestCallbacks.current.onSelectedThreadEvent(event);
          // Raw app-server lifecycle events are not render inputs here. The
          // gateway thread view owns live transcript truth.
          if (event.kind === "thread_view.refresh_required") {
            refetchSnapshot("refreshRequired");
            return;
          }
          if (isApprovalEvent(event)) {
            setApprovals((current) => latestCallbacks.current.onApprovalEvent(current, event));
            return;
          }
          if (isThreadViewQueueEvent(event)) {
            latestCallbacks.current.onQueueEvent(event);
            return;
          }
          if (!isCanonicalThreadViewRenderEvent(event, { includeGatewayDiagnostics: true })) {
            return;
          }
          setSyncNotice(null);
          enqueueTimelineEvent(event);
        },
      });
      client.connect();
      closeStream = client.close;
    };

    const loadInitialSnapshot = () => {
      void refreshSnapshot("loadingSnapshot", "initial")
        .then((revision) => {
          if (revision !== false && !cancelled) {
            connectSelectedThreadStream(revision);
          }
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          if (isTransientThreadSnapshotLoadError(error)) {
            setSyncNotice({
              message: `Selected thread history is still materializing. Retrying snapshot load: ${errorMessageFrom(error)}`,
              tone: "info",
            });
            materializingThreadRetry = setTimeout(loadInitialSnapshot, MATERIALIZING_THREAD_SNAPSHOT_RETRY_MS);
            return;
          }
          setSyncNotice(null);
          closeStream?.();
          closeStream = null;
          cancelQueuedTimelineEvents();
          clearEntryForThread(threadId);
          latestCallbacks.current.onThreadLoadFailed?.(threadId, error);
          latestCallbacks.current.onError(error);
        });
    };

    loadInitialSnapshot();

    return () => {
      cancelled = true;
      selectedThreadStreamToken.current += 1;
      olderHistoryRequest.current = null;
      if (materializingThreadRetry !== null) {
        clearTimeout(materializingThreadRetry);
      }
      closeStream?.();
      cancelQueuedTimelineEvents();
      requestTimelineRefresh.current = null;
      if (
        snapshotRefreshInFlight.current?.threadId === threadId &&
        snapshotRefreshInFlight.current.streamToken === streamToken
      ) {
        snapshotRefreshInFlight.current = null;
      }
    };
  }, [
    cancelQueuedTimelineEvents,
    enqueueTimelineEvent,
    isSelectedThreadSnapshotDeferred,
    selectedThreadId,
    setApprovals,
    setTimeline,
    setTimelineEntry,
  ]);

  return { loadOlderHistory };
}

function deltaTargetFromEvent(event: EventEnvelope): { itemId: string | null; threadId: string | null; turnId: string | null } {
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  return {
    itemId: stringValue(payload.itemId) ?? event.itemId ?? null,
    threadId: stringValue(payload.threadId) ?? event.threadId ?? null,
    turnId: stringValue(payload.turnId) ?? event.turnId ?? null,
  };
}

function deltaMissRelation(
  events: EventEnvelope[],
  missIndex: number,
  target: { itemId: string | null; turnId: string | null },
): SelectedThreadDeltaMissRelation {
  if (events.slice(0, missIndex).some((event) => patchMentionsDeltaTarget(event, target))) {
    return "patchEarlierInBatch";
  }
  if (events.slice(missIndex + 1).some((event) => patchMentionsDeltaTarget(event, target))) {
    return "patchLaterInBatch";
  }
  return "noPatchInBatch";
}

function deltaMissStateRelation(
  state: TimelineState,
  target: { itemId: string | null },
): "notIndexed" | "indexedButNotAppendable" {
  if (!target.itemId) {
    return "notIndexed";
  }
  const indexes = indexesForState(state);
  return timelineRowKeysByItemId(indexes, target.itemId).length === 0 ? "notIndexed" : "indexedButNotAppendable";
}

function patchMentionsDeltaTarget(event: EventEnvelope, target: { itemId: string | null; turnId: string | null }): boolean {
  if (event.kind !== "thread_view.patch" || !target.itemId) {
    return false;
  }
  return payloadMentionsTarget(event.payload, target);
}

function payloadMentionsTarget(value: unknown, target: { itemId: string | null; turnId: string | null }): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => payloadMentionsTarget(item, target));
  }
  const record = value as Record<string, unknown>;
  const itemId = stringValue(record.itemId) ?? stringValue(record.id);
  const turnId = stringValue(record.turnId);
  if (itemId === target.itemId && (!target.turnId || !turnId || turnId === target.turnId)) {
    return true;
  }
  return Object.values(record).some((item) => payloadMentionsTarget(item, target));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
