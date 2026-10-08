import { act, renderHook } from "@testing-library/react";
import { useState, type SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "../api/client";
import { createTimelineState, type TimelineState } from "./reducer";
import { useTimelineEventQueue } from "./useTimelineEventQueue";

function timelineEvent(id: string): EventEnvelope {
  return {
    codexMethod: "thread_view/item_delta",
    id,
    itemId: "item-1",
    kind: "thread_view.item_delta",
    payload: {
      delta: id,
      itemId: "item-1",
      threadId: "thread-1",
      turnId: "turn-1",
    },
    projectId: "project-1",
    receivedAt: "2026-06-05T00:00:00Z",
    seq: Number(id.replace("event-", "")),
    threadId: "thread-1",
    turnId: "turn-1",
  } as EventEnvelope;
}

// Observe submission itself as well as reduction, so a stale callback after unmount
// cannot pass merely because React ignores updates to an unmounted component.
function queueHarness(flushDelayMs: number) {
  const timeline = createTimelineState();
  const reduceEvents = vi.fn((current: TimelineState, _events: EventEnvelope[]) => current);
  const setTimeline = vi.fn((update: SetStateAction<TimelineState>) => {
    if (typeof update === "function") update(timeline);
  });
  const hook = renderHook(() => useTimelineEventQueue({ flushDelayMs, reduceEvents, setTimeline, timeline }));
  return { ...hook, reduceEvents, setTimeline };
}

const schedules = [{ name: "timer", delay: 35 }, { name: "animation frame", delay: 0 }];

describe("useTimelineEventQueue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("batches rapid live timeline events within the configured flush window", () => {
    vi.useFakeTimers();
    const reducerCalls: string[][] = [];

    const { result } = renderHook(() => {
      const [timeline, setTimeline] = useState<TimelineState>(() => createTimelineState());
      return useTimelineEventQueue({
        flushDelayMs: 64,
        reduceEvents: (current, events) => {
          reducerCalls.push(events.map((event) => event.id));
          return current;
        },
        setTimeline,
        timeline,
      });
    });

    act(() => {
      result.current.enqueueTimelineEvent(timelineEvent("event-3"));
      result.current.enqueueTimelineEvent(timelineEvent("event-1"));
      result.current.enqueueTimelineEvent(timelineEvent("event-2"));
    });

    expect(reducerCalls).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(63);
    });
    expect(reducerCalls).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(reducerCalls).toEqual([["event-3", "event-1", "event-2"]]);
  });

  it.each(schedules)("a full snapshot immediately flushes preceding deltas with $name scheduling", ({ delay }) => {
    vi.useFakeTimers();
    const { result, reduceEvents, setTimeline } = queueHarness(delay);
    const snapshot: EventEnvelope = {
      ...timelineEvent("event-3"), kind: "thread_view.patch",
      payload: { scope: "full_snapshot", viewRevision: 3, rows: [], turns: [], activeTurnId: null },
    };
    act(() => {
      result.current.enqueueTimelineEvent(timelineEvent("event-1"));
      result.current.enqueueTimelineEvent(timelineEvent("event-2"));
    });
    expect(setTimeline).not.toHaveBeenCalled();
    act(() => result.current.enqueueTimelineEvent(snapshot));
    expect(reduceEvents.mock.calls.map(([, events]) => events.map(event => event.id))).toEqual([
      ["event-1", "event-2", "event-3"],
    ]);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(setTimeline).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.enqueueTimelineEvent(timelineEvent("event-4"));
      vi.advanceTimersByTime(1000);
    });
    expect(reduceEvents.mock.calls.map(([, events]) => events.map(event => event.id))).toEqual([
      ["event-1", "event-2", "event-3"], ["event-4"],
    ]);
  });

  for (const operation of ["cancel", "unmount"] as const) {
    it.each(schedules)(`${operation} prevents pending commits with $name scheduling`, ({ delay }) => {
      vi.useFakeTimers();
      const requestFrame = vi.spyOn(window, "requestAnimationFrame");
      const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
      const { result, unmount, setTimeline, reduceEvents } = queueHarness(delay);
      act(() => {
        result.current.enqueueTimelineEvent(timelineEvent("event-1"));
        result.current.enqueueTimelineEvent(timelineEvent("event-2"));
      });
      if (delay === 0) expect(requestFrame).toHaveBeenCalledTimes(1);
      act(() => {
        if (operation === "unmount") unmount();
        else result.current.cancelQueuedTimelineEvents();
        vi.advanceTimersByTime(1000);
      });
      expect(setTimeline).not.toHaveBeenCalled();
      expect(reduceEvents).not.toHaveBeenCalled();
      if (delay === 0) expect(cancelFrame).toHaveBeenCalledWith(requestFrame.mock.results[0].value);
      if (operation === "cancel") {
        act(() => {
          result.current.enqueueTimelineEvent(timelineEvent("event-3"));
          vi.advanceTimersByTime(1000);
        });
        expect(reduceEvents.mock.calls.map(([, events]) => events.map(event => event.id))).toEqual([["event-3"]]);
      }
    });
  }

});
