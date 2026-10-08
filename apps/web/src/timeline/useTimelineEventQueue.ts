import { type Dispatch, type SetStateAction, useCallback, useEffect, useEffectEvent, useRef } from "react";

import type { EventEnvelope, ThreadViewPatch } from "../api/client";
import type { TimelineState } from "./reducer";

export type TimelineEventQueueReducer = (current: TimelineState, events: EventEnvelope[]) => TimelineState;

const DEFAULT_TIMELINE_EVENT_FLUSH_DELAY_MS = 48;

export function useTimelineEventQueue({
  flushDelayMs = defaultTimelineEventFlushDelayMs(),
  onSnapshotRequired,
  reduceEvents,
  setTimeline,
  timeline,
}: {
  flushDelayMs?: number;
  onSnapshotRequired?: () => void;
  reduceEvents: TimelineEventQueueReducer;
  setTimeline: Dispatch<SetStateAction<TimelineState>>;
  timeline: TimelineState;
}) {
  const queuedTimelineEvents = useRef<EventEnvelope[]>([]);
  const timelineFlushFrame = useRef<number | null>(null);
  const timelineFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestFlushDelayMs = useRef(flushDelayMs);
  const latestReduceEvents = useRef(reduceEvents);
  latestFlushDelayMs.current = flushDelayMs;
  latestReduceEvents.current = reduceEvents;
  const handledRefill = useRef<{ intent: object; revision: number } | null>(null);
  const requestSnapshot = useEffectEvent(() => onSnapshotRequired?.());
  const { snapshotRefillIntent, viewRevision } = timeline;

  useEffect(() => {
    if (!snapshotRefillIntent) return;
    if (handledRefill.current?.intent === snapshotRefillIntent && handledRefill.current.revision === viewRevision) return;
    // State updaters may be evaluated more than once. Only committed work can
    // request I/O; unchanged renders and errors must not retry it. A newer
    // projection during an outstanding repair needs a fresh canonical read.
    handledRefill.current = { intent: snapshotRefillIntent, revision: viewRevision };
    requestSnapshot();
  }, [snapshotRefillIntent, viewRevision]);

  const flushQueuedTimelineEvents = useCallback(() => {
    if (timelineFlushFrame.current !== null) {
      window.cancelAnimationFrame(timelineFlushFrame.current);
      timelineFlushFrame.current = null;
    }
    if (timelineFlushTimer.current !== null) {
      clearTimeout(timelineFlushTimer.current);
      timelineFlushTimer.current = null;
    }
    const events = queuedTimelineEvents.current;
    queuedTimelineEvents.current = [];
    if (events.length === 0) {
      return;
    }
    setTimeline((current) => latestReduceEvents.current(current, events));
  }, [setTimeline]);

  const scheduleQueuedTimelineFlush = useCallback(() => {
    if (timelineFlushFrame.current !== null || timelineFlushTimer.current !== null) {
      return;
    }

    const delayMs = Math.max(0, latestFlushDelayMs.current);
    if (delayMs > 0) {
      timelineFlushTimer.current = setTimeout(flushQueuedTimelineEvents, delayMs);
      return;
    }

    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      timelineFlushFrame.current = window.requestAnimationFrame(flushQueuedTimelineEvents);
      return;
    }

    timelineFlushTimer.current = setTimeout(flushQueuedTimelineEvents, 16);
  }, [flushQueuedTimelineEvents]);

  const enqueueTimelineEvent = useCallback((event: EventEnvelope) => {
    queuedTimelineEvents.current.push(event);
    // Apply canonical replacement before a following refetch marker can discard
    // buffered deltas. A slow or failed read must not hide an authoritative reset.
    if (event.kind === "thread_view.patch" && (event.payload as ThreadViewPatch | null)?.scope === "full_snapshot") {
      flushQueuedTimelineEvents();
      return;
    }
    scheduleQueuedTimelineFlush();
  }, [flushQueuedTimelineEvents, scheduleQueuedTimelineFlush]);

  const cancelQueuedTimelineEvents = useCallback(() => {
    if (timelineFlushFrame.current !== null) {
      window.cancelAnimationFrame(timelineFlushFrame.current);
      timelineFlushFrame.current = null;
    }
    if (timelineFlushTimer.current !== null) {
      clearTimeout(timelineFlushTimer.current);
      timelineFlushTimer.current = null;
    }
    queuedTimelineEvents.current = [];
  }, []);

  useEffect(() => cancelQueuedTimelineEvents, [cancelQueuedTimelineEvents]);

  return {
    cancelQueuedTimelineEvents,
    enqueueTimelineEvent,
  };
}

function defaultTimelineEventFlushDelayMs() {
  return import.meta.env.MODE === "test" ? 0 : DEFAULT_TIMELINE_EVENT_FLUSH_DELAY_MS;
}
