import { type Dispatch, type SetStateAction, useEffect, useRef } from "react";

import type { Approval, EventEnvelope } from "../api/client";
import { listEvents } from "../api/client";
import { isApprovalEvent } from "../approvals/state";
import { createEventStreamClient } from "../events/stream";
import { applyTimelineEventBatch } from "./batch";
import { idleTimelineEntry, type TimelineEntry } from "./entry";
import { createTimelineState, replayTimeline, type TimelineState } from "./reducer";

export function useSelectedThreadTimeline({
  isSelectedThreadNotLoaded,
  onApprovalEvent,
  onApprovalEvents,
  onError,
  onThreadMetadataEvent,
  onThreadMetadataEvents,
  selectedThreadId,
  setApprovals,
  setTimeline,
  setTimelineEntry,
}: {
  isSelectedThreadNotLoaded: boolean;
  onApprovalEvent: (current: Approval[], event: EventEnvelope) => Approval[];
  onApprovalEvents: (current: Approval[], events: EventEnvelope[]) => Approval[];
  onError: (error: unknown) => void;
  onThreadMetadataEvent: (event: EventEnvelope) => void;
  onThreadMetadataEvents: (events: EventEnvelope[]) => void;
  selectedThreadId: string | null;
  setApprovals: Dispatch<SetStateAction<Approval[]>>;
  setTimeline: Dispatch<SetStateAction<TimelineState>>;
  setTimelineEntry: Dispatch<SetStateAction<TimelineEntry>>;
}) {
  const queuedTimelineEvents = useRef<EventEnvelope[]>([]);
  const timelineFlushFrame = useRef<number | null>(null);
  const timelineFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedThreadStreamToken = useRef(0);
  const latestCallbacks = useRef({ onApprovalEvent, onApprovalEvents, onError, onThreadMetadataEvent, onThreadMetadataEvents });
  latestCallbacks.current = { onApprovalEvent, onApprovalEvents, onError, onThreadMetadataEvent, onThreadMetadataEvents };

  function clearEntry() {
    setTimelineEntry(idleTimelineEntry);
    setTimeline(createTimelineState());
  }

  function beginEntry(threadId: string) {
    setTimeline(createTimelineState());
    setTimelineEntry({ phase: "loading", threadId });
  }

  function markEntryAligning(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? { phase: "aligning", threadId } : current));
  }

  function clearEntryForThread(threadId: string) {
    setTimelineEntry((current) => (current.threadId === threadId ? idleTimelineEntry : current));
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

    let cancelled = false;
    let closeStream: (() => void) | null = null;
    const streamToken = selectedThreadStreamToken.current + 1;
    selectedThreadStreamToken.current = streamToken;
    listEvents(threadId)
      .then((events) => {
        if (cancelled) {
          return;
        }

        setApprovals((current) => latestCallbacks.current.onApprovalEvents(current, events));
        latestCallbacks.current.onThreadMetadataEvents(events);
        const timelineEvents = events.filter((event) => !isApprovalEvent(event));
        const replayedTimeline = replayTimeline(timelineEvents);
        setTimeline((current) => applyTimelineEventBatch(current, timelineEvents));
        markEntryAligning(threadId);
        const client = createEventStreamClient({
          cursor: replayedTimeline.lastSeq,
          threadId,
          onEvent: (event) => {
            if (selectedThreadStreamToken.current !== streamToken) {
              return;
            }
            if (event.threadId && event.threadId !== threadId) {
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
      })
      .catch((error) => {
        if (!cancelled) {
          clearEntryForThread(threadId);
          latestCallbacks.current.onError(error);
        }
      });

    return () => {
      cancelled = true;
      selectedThreadStreamToken.current += 1;
      closeStream?.();
      cancelQueuedTimelineEvents();
    };
  }, [isSelectedThreadNotLoaded, selectedThreadId, setApprovals, setTimeline, setTimelineEntry]);
}
