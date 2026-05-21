import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from "react";

import type { Approval, EventEnvelope, ThreadSummary, ThreadViewThreadSummary } from "../api/client";
import { getThreadDetail, getThreadTimelinePage } from "../api/client";
import { isApprovalEvent } from "../approvals/state";
import { createEventStreamClient } from "../events/stream";
import { errorMessageFrom } from "../shared/values";
import { applyTimelineEventBatch } from "./batch";
import { idleTimelineEntry, type TimelineEntry } from "./entry";
import {
  applyTimelineHistoryWindow,
  applyTimelineSnapshot,
  createTimelineState,
  setTimelineOlderHistoryLoading,
  type TimelineState,
} from "./reducer";

const MATERIALIZING_THREAD_SNAPSHOT_RETRY_MS = 250;

export type ThreadSyncNotice = {
  message: string;
  tone: "info" | "warning";
};

export function useSelectedThreadTimeline({
  isSelectedThreadSnapshotDeferred,
  onApprovalEvent,
  onError,
  onQueueEvent,
  onSnapshotThread,
  onSyncNotice,
  onThreadLoadFailed,
  onThreadMetadataEvent,
  selectedThreadId,
  setApprovals,
  setTimeline,
  setTimelineEntry,
}: {
  isSelectedThreadSnapshotDeferred: boolean;
  onApprovalEvent: (current: Approval[], event: EventEnvelope) => Approval[];
  onError: (error: unknown) => void;
  onQueueEvent: (event: EventEnvelope) => void;
  onSnapshotThread: (thread: ThreadSummary) => void;
  onSyncNotice?: (notice: ThreadSyncNotice | null) => void;
  onThreadLoadFailed?: (threadId: string, error: unknown) => void;
  onThreadMetadataEvent: (event: EventEnvelope) => void;
  selectedThreadId: string | null;
  setApprovals: Dispatch<SetStateAction<Approval[]>>;
  setTimeline: Dispatch<SetStateAction<TimelineState>>;
  setTimelineEntry: Dispatch<SetStateAction<TimelineEntry>>;
}) {
  const queuedTimelineEvents = useRef<EventEnvelope[]>([]);
  const timelineFlushFrame = useRef<number | null>(null);
  const timelineFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedThreadStreamToken = useRef(0);
  const olderHistoryRequest = useRef<{ threadId: string; cursor: string } | null>(null);
  const latestCallbacks = useRef({
    onApprovalEvent,
    onError,
    onQueueEvent,
    onSnapshotThread,
    onSyncNotice,
    onThreadLoadFailed,
    onThreadMetadataEvent,
  });
  latestCallbacks.current = {
    onApprovalEvent,
    onError,
    onQueueEvent,
    onSnapshotThread,
    onSyncNotice,
    onThreadLoadFailed,
    onThreadMetadataEvent,
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

  function scheduleQueuedTimelineFlush() {
    if (timelineFlushFrame.current !== null || timelineFlushTimer.current !== null) {
      return;
    }

    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      timelineFlushFrame.current = window.requestAnimationFrame(flushQueuedTimelineEvents);
      return;
    }

    timelineFlushTimer.current = setTimeout(flushQueuedTimelineEvents, 16);
  }

  function flushQueuedTimelineEvents() {
    if (timelineFlushFrame.current !== null) {
      timelineFlushFrame.current = null;
    }
    if (timelineFlushTimer.current !== null) {
      timelineFlushTimer.current = null;
    }
    const events = queuedTimelineEvents.current;
    queuedTimelineEvents.current = [];
    if (events.length === 0) {
      return;
    }
    setTimeline((current) => applyTimelineEventBatch(current, events));
  }

  function cancelQueuedTimelineEvents() {
    if (timelineFlushFrame.current !== null) {
      window.cancelAnimationFrame(timelineFlushFrame.current);
      timelineFlushFrame.current = null;
    }
    if (timelineFlushTimer.current !== null) {
      clearTimeout(timelineFlushTimer.current);
      timelineFlushTimer.current = null;
    }
    queuedTimelineEvents.current = [];
  }

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

    async function refreshSnapshot(phase: "loadingSnapshot" | "refreshingSnapshot") {
      if (phase === "refreshingSnapshot") {
        markEntryRefreshing(threadId);
      }
      const snapshot = await getThreadDetail(threadId);
      if (cancelled || selectedThreadStreamToken.current !== streamToken) {
        return false;
      }
      setTimeline((current) => applyTimelineSnapshot(current, snapshot));
      latestCallbacks.current.onSnapshotThread(threadViewSummaryToThreadSummary(snapshot.thread));
      setSyncNotice(null);
      markEntryStreaming(threadId);
      return snapshot.timeline?.viewRevision ?? 0;
    }

    const refetchSnapshot = (reason: "refreshRequired" | "streamReconnect") => {
      if (reason === "streamReconnect") {
        setSyncNotice({
          message: "Selected thread stream disconnected. Reconnecting and retrying thread refresh.",
          tone: "warning",
        });
      }
      void refreshSnapshot("refreshingSnapshot").catch((error) => {
        if (cancelled) {
          return;
        }
        setSyncNotice({
          message:
            reason === "streamReconnect"
              ? `Selected thread stream disconnected. Reconnecting and retrying thread refresh: ${errorMessageFrom(error)}`
              : `Selected thread refresh failed. Retrying on the next gateway update: ${errorMessageFrom(error)}`,
          tone: "warning",
        });
      });
    };

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
          if (selectedThreadStreamToken.current !== streamToken) {
            return;
          }
          if (event.threadId && event.threadId !== threadId) {
            return;
          }
          // Raw app-server lifecycle events are not render inputs here. The
          // gateway thread view owns live transcript truth.
          if (event.kind === "thread_view.refresh_required") {
            refetchSnapshot("refreshRequired");
            return;
          }
          latestCallbacks.current.onThreadMetadataEvent(event);
          if (isApprovalEvent(event)) {
            setApprovals((current) => latestCallbacks.current.onApprovalEvent(current, event));
            return;
          }
          if (isQueueEvent(event)) {
            latestCallbacks.current.onQueueEvent(event);
            return;
          }
          if (!isCanonicalTimelineRenderEvent(event)) {
            return;
          }
          setSyncNotice(null);
          queuedTimelineEvents.current.push(event);
          scheduleQueuedTimelineFlush();
        },
      });
      client.connect();
      closeStream = client.close;
    };

    const loadInitialSnapshot = () => {
      void refreshSnapshot("loadingSnapshot")
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
    };
  }, [isSelectedThreadSnapshotDeferred, selectedThreadId, setApprovals, setTimeline, setTimelineEntry]);

  return { loadOlderHistory };
}

function threadViewSummaryToThreadSummary(thread: ThreadViewThreadSummary): ThreadSummary {
  return {
    ...thread,
    rawPayload: {},
  };
}

function isQueueEvent(event: EventEnvelope): boolean {
  return event.kind === "turn_queue.item_upsert" || event.kind === "turn_queue.item_deleted";
}

function isCanonicalTimelineRenderEvent(event: EventEnvelope): boolean {
  return event.kind === "thread_view.patch" || event.kind === "thread_view.item_delta";
}

function isTransientThreadSnapshotLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not materialized yet") ||
    normalized.includes("failed to load rollout") ||
    normalized.includes("failed to load thread history") ||
    (normalized.includes("rollout at") && normalized.includes(" is empty"))
  );
}
