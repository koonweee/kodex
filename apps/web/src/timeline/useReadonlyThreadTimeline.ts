import { useEffect, useRef, useState } from "react";

import type { EventEnvelope, ThreadSummary } from "../api/client";
import { getThreadDetail } from "../api/client";
import { isApprovalEvent } from "../approvals/state";
import { createEventStreamClient } from "../events/stream";
import { applyTimelineEventBatch } from "./batch";
import { idleTimelineEntry, type TimelineEntry } from "./entry";
import { applyTimelineSnapshot, canApplyThreadViewItemDelta, createTimelineState, type TimelineState } from "./reducer";
import {
  isCanonicalThreadViewRenderEvent,
  isThreadViewQueueEvent,
  threadViewSummaryToThreadSummary,
} from "./threadViewEvents";
import { useTimelineEventQueue } from "./useTimelineEventQueue";

export function useReadonlyThreadTimeline({
  onError,
  onSnapshotThread,
  threadId,
}: {
  onError: (error: unknown) => void;
  onSnapshotThread?: (thread: ThreadSummary) => void;
  threadId: string | null;
}) {
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

  function reduceQueuedTimelineEvents(current: TimelineState, events: EventEnvelope[]) {
    if (events.length === 0) {
      return current;
    }
    const shouldRefresh = events.some((event) => !canApplyThreadViewItemDelta(current, event));
    const next = applyTimelineEventBatch(current, events);
    if (shouldRefresh) {
      requestTimelineRefresh.current?.();
    }
    return next;
  }

  const { cancelQueuedTimelineEvents, enqueueTimelineEvent } = useTimelineEventQueue({
    reduceEvents: reduceQueuedTimelineEvents,
    setTimeline,
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
    const currentThreadId = threadId;
    const currentToken = streamToken.current + 1;
    streamToken.current = currentToken;
    markLoading(currentThreadId);

    async function refreshSnapshot(phase: "loadingSnapshot" | "refreshingSnapshot") {
      if (phase === "refreshingSnapshot") {
        markRefreshing(currentThreadId);
      }
      const snapshot = await getThreadDetail(currentThreadId);
      if (cancelled || streamToken.current !== currentToken) {
        return false;
      }
      setTimeline((current) => applyTimelineSnapshot(current, snapshot));
      latestCallbacks.current.onSnapshotThread?.(threadViewSummaryToThreadSummary(snapshot.thread));
      markStreaming(currentThreadId);
      return snapshot.timeline?.viewRevision ?? 0;
    }

    const refetchSnapshot = () => {
      void refreshSnapshot("refreshingSnapshot").catch((error) => {
        if (!cancelled) {
          latestCallbacks.current.onError(error);
        }
      });
    };
    requestTimelineRefresh.current = refetchSnapshot;

    const connectStream = (cursor: number) => {
      const client = createEventStreamClient({
        cursor,
        threadId: currentThreadId,
        onStatusChange: (status) => {
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
          if (isApprovalEvent(event) || isThreadViewQueueEvent(event)) {
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
      streamToken.current += 1;
      closeStream?.();
      cancelQueuedTimelineEvents();
      requestTimelineRefresh.current = null;
    };
  }, [cancelQueuedTimelineEvents, enqueueTimelineEvent, threadId]);

  return {
    isLoading: timelineEntry.phase === "loadingSnapshot",
    scrollParentElement,
    setScrollParentElement,
    timeline,
    timelineEntry,
  };
}
