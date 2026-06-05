import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
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

describe("useTimelineEventQueue", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches rapid live timeline events within the configured flush window", () => {
    vi.useFakeTimers();
    const reducerCalls: string[][] = [];

    const { result } = renderHook(() => {
      const [, setTimeline] = useState<TimelineState>(() => createTimelineState());
      return useTimelineEventQueue({
        flushDelayMs: 64,
        reduceEvents: (current, events) => {
          reducerCalls.push(events.map((event) => event.id));
          return current;
        },
        setTimeline,
      });
    });

    act(() => {
      result.current.enqueueTimelineEvent(timelineEvent("event-1"));
      result.current.enqueueTimelineEvent(timelineEvent("event-2"));
      result.current.enqueueTimelineEvent(timelineEvent("event-3"));
    });

    expect(reducerCalls).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(63);
    });
    expect(reducerCalls).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(reducerCalls).toEqual([["event-1", "event-2", "event-3"]]);
  });
});
