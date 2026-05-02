import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";

import type { Approval, EventEnvelope, ThreadSummary } from "../api/client";
import { getThreadDetail } from "../api/client";
import { isApprovalEvent } from "../approvals/state";
import { createEventStreamClient } from "../events/stream";
import { applyTimelineEventBatch } from "./batch";
import { idleTimelineEntry, type TimelineEntry } from "./entry";
import { applyTimelineSnapshot, createTimelineState, type TimelineState } from "./reducer";

const MATERIALIZING_THREAD_SNAPSHOT_RETRY_MS = 250;

export function useSelectedThreadTimeline({
  isSelectedThreadNotLoaded,
  isSelectedThreadSnapshotDeferred,
  onApprovalEvent,
  onError,
  onSnapshotThread,
  onThreadMetadataEvent,
  selectedThreadId,
  setApprovals,
  setTimeline,
  setTimelineEntry,
}: {
  isSelectedThreadNotLoaded: boolean;
  isSelectedThreadSnapshotDeferred: boolean;
  onApprovalEvent: (current: Approval[], event: EventEnvelope) => Approval[];
  onError: (error: unknown) => void;
  onSnapshotThread: (thread: ThreadSummary) => void;
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
  const latestCallbacks = useRef({ onApprovalEvent, onError, onSnapshotThread, onThreadMetadataEvent });
  latestCallbacks.current = { onApprovalEvent, onError, onSnapshotThread, onThreadMetadataEvent };

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

  useEffect(() => {
    if (!selectedThreadId) {
      selectedThreadStreamToken.current += 1;
      cancelQueuedTimelineEvents();
      clearEntry();
      return;
    }

    const threadId = selectedThreadId;
    if (isSelectedThreadNotLoaded) {
      beginEntry(threadId);
      return;
    }
    if (isSelectedThreadSnapshotDeferred) {
      selectedThreadStreamToken.current += 1;
      cancelQueuedTimelineEvents();
      markEntryStreaming(threadId);
      return;
    }

    let cancelled = false;
    let closeStream: (() => void) | null = null;
    let materializingThreadRetry: ReturnType<typeof setTimeout> | null = null;
    const streamToken = selectedThreadStreamToken.current + 1;
    selectedThreadStreamToken.current = streamToken;

    async function refreshSnapshot(phase: "loadingSnapshot" | "refreshingSnapshot") {
      if (phase === "refreshingSnapshot") {
        markEntryRefreshing(threadId);
      }
      const snapshot = await getThreadDetail(threadId);
      if (cancelled || selectedThreadStreamToken.current !== streamToken) {
        return false;
      }
      setTimeline((current) => applyTimelineSnapshot(current, snapshot));
      latestCallbacks.current.onSnapshotThread(snapshot.thread);
      markEntryStreaming(threadId);
      return true;
    }

    const refetchSnapshot = () => {
      void refreshSnapshot("refreshingSnapshot").catch((error) => {
        if (cancelled) {
          return;
        }
        latestCallbacks.current.onError(error);
      });
    };

    const connectSelectedThreadStream = () => {
      const client = createEventStreamClient({
        threadId,
        onStatusChange: (status) => {
          if (status === "reconnecting" && selectedThreadStreamToken.current === streamToken) {
            refetchSnapshot();
          }
        },
        onEvent: (event) => {
          if (selectedThreadStreamToken.current !== streamToken) {
            return;
          }
          if (event.threadId && event.threadId !== threadId) {
            return;
          }
          if (event.kind === "timeline.snapshot_required") {
            refetchSnapshot();
            return;
          }
          latestCallbacks.current.onThreadMetadataEvent(event);
          if (isApprovalEvent(event)) {
            setApprovals((current) => latestCallbacks.current.onApprovalEvent(current, event));
            return;
          }
          queuedTimelineEvents.current.push(event);
          scheduleQueuedTimelineFlush();
        },
      });
      client.connect();
      closeStream = client.close;
    };

    const loadInitialSnapshot = () => {
      void refreshSnapshot("loadingSnapshot")
        .then((loaded) => {
          if (!loaded || cancelled) {
            return;
          }
          connectSelectedThreadStream();
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          if (isThreadMaterializingError(error)) {
            materializingThreadRetry = setTimeout(loadInitialSnapshot, MATERIALIZING_THREAD_SNAPSHOT_RETRY_MS);
            return;
          }
          clearEntryForThread(threadId);
          latestCallbacks.current.onError(error);
        });
    };

    loadInitialSnapshot();

    return () => {
      cancelled = true;
      selectedThreadStreamToken.current += 1;
      if (materializingThreadRetry !== null) {
        clearTimeout(materializingThreadRetry);
      }
      closeStream?.();
      cancelQueuedTimelineEvents();
    };
  }, [isSelectedThreadNotLoaded, isSelectedThreadSnapshotDeferred, selectedThreadId, setApprovals, setTimeline, setTimelineEntry]);
}

function isThreadMaterializingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes("not materialized yet") && normalized.includes("includeturns");
}
