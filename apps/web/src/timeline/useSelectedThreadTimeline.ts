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
  onQueueEvent,
  onSnapshotThread,
  onThreadLoadFailed,
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
  onQueueEvent: (event: EventEnvelope) => void;
  onSnapshotThread: (thread: ThreadSummary) => void;
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
  const latestCallbacks = useRef({
    onApprovalEvent,
    onError,
    onQueueEvent,
    onSnapshotThread,
    onThreadLoadFailed,
    onThreadMetadataEvent,
  });
  latestCallbacks.current = {
    onApprovalEvent,
    onError,
    onQueueEvent,
    onSnapshotThread,
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
      return snapshot.timeline?.viewRevision ?? 0;
    }

    const refetchSnapshot = () => {
      void refreshSnapshot("refreshingSnapshot").catch((error) => {
        if (cancelled) {
          return;
        }
        latestCallbacks.current.onError(error);
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
          // Raw app-server lifecycle events are not render inputs here. The
          // gateway thread view owns live transcript truth.
          if (event.kind === "thread_view.refresh_required") {
            refetchSnapshot();
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
            materializingThreadRetry = setTimeout(loadInitialSnapshot, MATERIALIZING_THREAD_SNAPSHOT_RETRY_MS);
            return;
          }
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
      if (materializingThreadRetry !== null) {
        clearTimeout(materializingThreadRetry);
      }
      closeStream?.();
      cancelQueuedTimelineEvents();
    };
  }, [isSelectedThreadNotLoaded, isSelectedThreadSnapshotDeferred, selectedThreadId, setApprovals, setTimeline, setTimelineEntry]);
}

function isQueueEvent(event: EventEnvelope): boolean {
  return event.kind === "turn_queue.item_upsert" || event.kind === "turn_queue.item_deleted";
}

function isCanonicalTimelineRenderEvent(event: EventEnvelope): boolean {
  return event.kind === "thread_view.patch";
}

function isTransientThreadSnapshotLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not materialized yet") ||
    normalized.includes("failed to load rollout") ||
    normalized.includes("failed to load thread history")
  );
}
