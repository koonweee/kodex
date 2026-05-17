import { useEffect, useRef, useState } from "react";

import type { EventEnvelope, ThreadSummary } from "../api/client";
import { getThreadDetail } from "../api/client";
import { isApprovalEvent } from "../approvals/state";
import { createEventStreamClient } from "../events/stream";
import { applyTimelineEventBatch } from "./batch";
import { idleTimelineEntry, type TimelineEntry } from "./entry";
import { applyTimelineSnapshot, createTimelineState, type TimelineState } from "./reducer";

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
  const queuedTimelineEvents = useRef<EventEnvelope[]>([]);
  const timelineFlushFrame = useRef<number | null>(null);
  const timelineFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamToken = useRef(0);
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
      latestCallbacks.current.onSnapshotThread?.(snapshot.thread);
      markStreaming(currentThreadId);
      return snapshot.timeline?.revision ?? 0;
    }

    const refetchSnapshot = () => {
      void refreshSnapshot("refreshingSnapshot").catch((error) => {
        if (!cancelled) {
          latestCallbacks.current.onError(error);
        }
      });
    };

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
          if (event.kind === "timeline.snapshot_required") {
            refetchSnapshot();
            return;
          }
          if (isApprovalEvent(event) || isQueueEvent(event)) {
            return;
          }
          if (!isCanonicalTimelineRenderEvent(event)) {
            return;
          }
          queuedTimelineEvents.current.push(event);
          scheduleQueuedTimelineFlush();
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
    };
  }, [threadId]);

  return {
    isLoading: timelineEntry.phase === "loadingSnapshot",
    scrollParentElement,
    setScrollParentElement,
    timeline,
    timelineEntry,
  };
}

function isQueueEvent(event: EventEnvelope): boolean {
  return event.kind === "turn_queue.item_upsert" || event.kind === "turn_queue.item_deleted";
}

function isCanonicalTimelineRenderEvent(event: EventEnvelope): boolean {
  return event.kind === "timeline.snapshot" || event.kind === "timeline.projection_patch";
}
