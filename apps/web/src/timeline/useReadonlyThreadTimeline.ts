import { useEffect, useRef, useState } from "react";

import type { ThreadSummary } from "../api/client";
import { getThreadDetail } from "../api/client";
import { useGatewayInstanceValidation, useGatewayStreamConnected } from "../api/GatewayInstanceBoundary";
import { isApprovalEvent } from "../approvals/state";
import { createEventStreamClient } from "../events/stream";
import { applyTimelineEventBatch } from "./batch";
import { idleTimelineEntry, type TimelineEntry } from "./entry";
import { applyTimelineSnapshot, createTimelineState, type TimelineState } from "./reducer";
import {
  isCanonicalThreadViewRenderEvent,
  threadViewSummaryToThreadSummary,
} from "./threadViewEvents";
import { useTimelineEventQueue } from "./useTimelineEventQueue";

export function useReadonlyThreadTimeline({
  timelineEventFlushDelayMs,
  onError,
  onSnapshotThread,
  threadId,
}: {
  timelineEventFlushDelayMs?: number;
  onError: (error: unknown) => void;
  onSnapshotThread?: (thread: ThreadSummary) => void;
  threadId: string | null;
}) {
  const validateInstance = useGatewayInstanceValidation();
  const handleStreamConnected = useGatewayStreamConnected();
  const [timeline, setTimeline] = useState<TimelineState>(() => createTimelineState());
  const [timelineEntry, setTimelineEntry] = useState<TimelineEntry>(idleTimelineEntry);
  const [scrollParentElement, setScrollParentElement] = useState<HTMLDivElement | null>(null);
  const streamToken = useRef(0);
  const requestTimelineRefresh = useRef<(() => void) | null>(null);
  const latestCallbacks = useRef({ onError, onSnapshotThread });
  latestCallbacks.current = { onError, onSnapshotThread };

  function clearEntry() {
    setTimeline(createTimelineState());
    setTimelineEntry(idleTimelineEntry);
  }

  function markLoading(nextThreadId: string) {
    setTimeline(createTimelineState());
    setTimelineEntry({ phase: "loadingSnapshot", threadId: nextThreadId });
  }

  function markStreaming(nextThreadId: string) {
    setTimelineEntry((current) =>
      current.threadId === nextThreadId ? { phase: "streamingLive", threadId: nextThreadId } : current,
    );
  }

  function markRefreshing(nextThreadId: string) {
    setTimelineEntry((current) =>
      current.threadId === nextThreadId ? { phase: "refreshingSnapshot", threadId: nextThreadId } : current,
    );
  }

  function markError(nextThreadId: string) {
    setTimelineEntry((current) =>
      current.threadId === nextThreadId ? { phase: "error", threadId: nextThreadId } : current,
    );
  }

  const { cancelQueuedTimelineEvents, enqueueTimelineEvent } = useTimelineEventQueue({
    flushDelayMs: timelineEventFlushDelayMs,
    onSnapshotRequired: () => requestTimelineRefresh.current?.(),
    reduceEvents: applyTimelineEventBatch,
    setTimeline,
    timeline,
  });

  useEffect(() => {
    if (!threadId) {
      streamToken.current += 1;
      cancelQueuedTimelineEvents();
      clearEntry();
      return;
    }

    let cancelled = false;
    let closeStream: (() => void) | null = null;
    let snapshotController: AbortController | null = null;
    const currentThreadId = threadId;
    const currentToken = streamToken.current + 1;
    streamToken.current = currentToken;
    markLoading(currentThreadId);

    async function refreshSnapshot(phase: "loadingSnapshot" | "refreshingSnapshot") {
      snapshotController?.abort();
      const controller = new AbortController();
      snapshotController = controller;
      if (phase === "refreshingSnapshot") {
        markRefreshing(currentThreadId);
      }
      try {
        const snapshot = await getThreadDetail(currentThreadId, controller.signal);
        if (controller.signal.aborted || cancelled || streamToken.current !== currentToken) {
          return false;
        }
        setTimeline((current) => applyTimelineSnapshot(current, snapshot));
        latestCallbacks.current.onSnapshotThread?.(threadViewSummaryToThreadSummary(snapshot.thread));
        markStreaming(currentThreadId);
        return snapshot.timeline?.viewRevision ?? 0;
      } catch (error) {
        if (controller.signal.aborted) return false;
        throw error;
      }
    }

    const refetchSnapshot = () => {
      cancelQueuedTimelineEvents();
      void refreshSnapshot("refreshingSnapshot").catch((error) => {
        if (!cancelled) {
          latestCallbacks.current.onError(error);
        }
      });
    };
    requestTimelineRefresh.current = refetchSnapshot;

    const connectStream = (cursor: number) => {
      const client = createEventStreamClient({
        beforeConnect: validateInstance,
        cursor,
        threadId: currentThreadId,
        onStatusChange: (status) => {
          if (status === "connected") handleStreamConnected?.();
          if (status === "reconnecting" && streamToken.current === currentToken) {
            refetchSnapshot();
          }
        },
        onEvent: (event) => {
          if (streamToken.current !== currentToken) {
            return;
          }
          if (event.threadId && event.threadId !== currentThreadId) {
            return;
          }
          // Raw app-server lifecycle events are not render inputs here. The
          // gateway thread view owns live transcript truth.
          if (event.kind === "thread_view.refresh_required") {
            refetchSnapshot();
            return;
          }
          if (isApprovalEvent(event)) {
            return;
          }
          if (!isCanonicalThreadViewRenderEvent(event)) {
            return;
          }
          enqueueTimelineEvent(event);
        },
      });
      client.connect();
      closeStream = client.close;
    };

    void refreshSnapshot("loadingSnapshot")
      .then((revision) => {
        if (revision !== false && !cancelled) {
          connectStream(revision);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        markError(currentThreadId);
        latestCallbacks.current.onError(error);
      });

    return () => {
      cancelled = true;
      snapshotController?.abort();
      streamToken.current += 1;
      closeStream?.();
      cancelQueuedTimelineEvents();
      requestTimelineRefresh.current = null;
    };
  }, [cancelQueuedTimelineEvents, enqueueTimelineEvent, handleStreamConnected, threadId, validateInstance]);

  return {
    isLoading: timelineEntry.phase === "loadingSnapshot",
    scrollParentElement,
    setScrollParentElement,
    timeline,
    timelineEntry,
  };
}
