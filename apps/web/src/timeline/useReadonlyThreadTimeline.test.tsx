import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getThreadDetail, type EventEnvelope, type ThreadViewResponse } from "../api/client";
import type { TimelineState } from "./reducer";
import { useReadonlyThreadTimeline } from "./useReadonlyThreadTimeline";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    getThreadDetail: vi.fn(),
  };
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emitNamed(type: string, payload: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(payload) } as MessageEvent<string>);
    }
  }
}

describe("useReadonlyThreadTimeline", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    FakeEventSource.instances = [];
  });

  it("drops delayed render events before applying a refresh-required snapshot", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(getThreadDetail)
      .mockResolvedValueOnce(threadDetail("Base", 1))
      .mockResolvedValueOnce(threadDetail("Recovered", 3));

    const { result } = renderHook(() =>
      useReadonlyThreadTimeline({
        onError: vi.fn(),
        threadId: "thread-1",
        timelineEventFlushDelayMs: 64,
      }),
    );

    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Base"));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0].emitNamed(
        "thread_view.item_delta",
        itemDeltaEvent({ delta: " stale", seq: 3 }),
      );
    });
    expect(timelineText(result.current.timeline)).toBe("Base");

    act(() => {
      FakeEventSource.instances[0].emitNamed("thread_view.refresh_required", refreshRequiredEvent(4));
    });
    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Recovered"));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(timelineText(result.current.timeline)).toBe("Recovered");
    expect(getThreadDetail).toHaveBeenCalledTimes(2);
  });

  it("drops equal-revision render events queued while refresh recovery is in flight", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveRefresh: (snapshot: ThreadViewResponse) => void = () => undefined;
    const refreshSnapshot = new Promise<ThreadViewResponse>((resolve) => {
      resolveRefresh = resolve;
    });
    vi.mocked(getThreadDetail)
      .mockResolvedValueOnce(threadDetail("Base", 1))
      .mockReturnValueOnce(refreshSnapshot);

    const { result } = renderHook(() =>
      useReadonlyThreadTimeline({
        onError: vi.fn(),
        threadId: "thread-1",
        timelineEventFlushDelayMs: 64,
      }),
    );

    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Base"));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      FakeEventSource.instances[0].emitNamed("thread_view.refresh_required", refreshRequiredEvent(2));
      FakeEventSource.instances[0].emitNamed(
        "thread_view.item_delta",
        itemDeltaEvent({ delta: " stale", seq: 3 }),
      );
    });
    expect(timelineText(result.current.timeline)).toBe("Base");

    await act(async () => {
      resolveRefresh(threadDetail("Recovered", 3));
      await refreshSnapshot;
    });
    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Recovered"));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(timelineText(result.current.timeline)).toBe("Recovered");
    expect(getThreadDetail).toHaveBeenCalledTimes(2);
  });
});

function timelineText(timeline: TimelineState) {
  return timeline.rows
    .flatMap((row) => (row.type === "item" ? [row.item.text] : []))
    .filter(Boolean)
    .join("");
}

function threadDetail(text: string, viewRevision: number): ThreadViewResponse {
  const item = {
    id: "projection-turn-1-agent-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "agent-1",
    itemType: "agentMessage",
    status: "running",
    displayOrder: 1,
    codexMethod: "item/upsert",
    timestampMs: 1,
    payload: {
      item: { id: "agent-1", type: "agentMessage", text },
      itemId: "agent-1",
      itemSnapshot: { id: "agent-1", itemType: "agentMessage" },
      source: "appServerSnapshot" as const,
      turnId: "turn-1",
    },
  };
  return {
    historyPage: null,
    liveState: "streaming",
    thread: {
      id: "thread-1",
      name: "Readonly thread",
      cwd: "/workspace",
      status: "active",
      source: "local",
      preview: text,
      notificationsEnabled: true,
      createdAt: 1777500000,
      seenCompletedAgentTurnSeq: 0,
      updatedAt: 1777501200,
      unreadCompletedAgentTurn: false,
    },
    timeline: {
      activeTurnId: "turn-1",
      liveState: "streaming",
      pendingApprovalRequests: [],
      pendingUserInputRequests: [],
      rows: [{
        collapsedRows: [],
        displayOrder: 1,
        dividerBefore: null,
        fileChanges: [],
        id: "item-projection-turn-1-agent-1",
        item,
        items: [],
        kind: "assistant_message",
        status: "running",
        timestampMs: 1,
        turnId: "turn-1",
        work: null,
      }],
      turns: [{ id: "turn-1", status: "running" }],
      viewRevision,
    },
  };
}

function itemDeltaEvent({ delta, seq }: { delta: string; seq: number }): EventEnvelope {
  return {
    codexMethod: "thread_view/item_delta",
    id: `event-${seq}`,
    itemId: "agent-1",
    kind: "thread_view.item_delta",
    payload: {
      delta,
      itemId: "agent-1",
      threadId: "thread-1",
      turnId: "turn-1",
      viewRevision: seq,
    },
    projectId: "project-1",
    receivedAt: "2026-06-05T00:00:00Z",
    seq,
    threadId: "thread-1",
    turnId: "turn-1",
  };
}

function refreshRequiredEvent(seq: number): EventEnvelope {
  return {
    codexMethod: "thread_view/refresh_required",
    id: `refresh-${seq}`,
    itemId: null,
    kind: "thread_view.refresh_required",
    payload: { reason: "snapshot_required", threadId: "thread-1" },
    projectId: "project-1",
    receivedAt: "2026-06-05T00:00:00Z",
    seq,
    threadId: "thread-1",
    turnId: null,
  };
}
