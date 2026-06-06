import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef } from "react";

import type { EventEnvelope } from "../api/client";
import type { TimelineState } from "./reducer";

export type TimelineEventQueueReducer = (current: TimelineState, events: EventEnvelope[]) => TimelineState;

const DEFAULT_TIMELINE_EVENT_FLUSH_DELAY_MS = 64;

export function useTimelineEventQueue({
  flushDelayMs = defaultTimelineEventFlushDelayMs(),
  reduceEvents,
  setTimeline,
}: {
  flushDelayMs?: number;
  reduceEvents: TimelineEventQueueReducer;
  setTimeline: Dispatch<SetStateAction<TimelineState>>;
}) {
  const queuedTimelineEvents = useRef<EventEnvelope[]>([]);
  const timelineFlushFrame = useRef<number | null>(null);
  const timelineFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestFlushDelayMs = useRef(flushDelayMs);
  const latestReduceEvents = useRef(reduceEvents);
  latestFlushDelayMs.current = flushDelayMs;
  latestReduceEvents.current = reduceEvents;

  const flushQueuedTimelineEvents = useCallback(() => {
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
    scheduleQueuedTimelineFlush();
  }, [scheduleQueuedTimelineFlush]);

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
