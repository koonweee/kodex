import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachThread, getThreadDetail, type EventEnvelope, type ThreadViewResponse } from "../api/client";
import type { TimelineState } from "./reducer";
import { useReadonlyThreadTimeline } from "./useReadonlyThreadTimeline";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    attachThread: vi.fn(),
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

  it("keeps two read-only observers on history reads when their streams reconnect", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let snapshot = threadDetail("Stored history", 1);
    vi.mocked(getThreadDetail).mockReset().mockImplementation(async () => snapshot);
    const first = renderHook(() => useReadonlyThreadTimeline({ onError: vi.fn(), threadId: "thread-1" }));
    const second = renderHook(() => useReadonlyThreadTimeline({ onError: vi.fn(), threadId: "thread-1" }));
    await waitFor(() => expect(timelineText(first.result.current.timeline)).toBe("Stored history"));
    await waitFor(() => expect(timelineText(second.result.current.timeline)).toBe("Stored history"));
    expect(getThreadDetail).toHaveBeenCalledTimes(2);
    expect(attachThread).not.toHaveBeenCalled();

    snapshot = threadDetail("Recovered stored history", 2);
    act(() => FakeEventSource.instances.forEach((stream) => stream.onerror?.()));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(4), { timeout: 2_000 });
    await waitFor(() => expect(timelineText(first.result.current.timeline)).toBe("Recovered stored history"));
    await waitFor(() => expect(timelineText(second.result.current.timeline)).toBe("Recovered stored history"));
    expect(getThreadDetail).toHaveBeenCalledTimes(4);
    expect(attachThread).not.toHaveBeenCalled();
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

  it.each(["success", "failure"])("fences a pre-revert observer read and its late %s without attaching", async (outcome) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let release!: (snapshot: ThreadViewResponse) => void;
    let reject!: (error: Error) => void;
    const oldRead = new Promise<ThreadViewResponse>((resolve, rejectPromise) => { release = resolve; reject = rejectPromise; });
    let releaseRefill!: (snapshot: ThreadViewResponse) => void;
    const refill = new Promise<ThreadViewResponse>((resolve) => { releaseRefill = resolve; });
    vi.mocked(getThreadDetail).mockReset()
      .mockResolvedValueOnce(threadDetail("Removed history", 1))
      .mockReturnValueOnce(oldRead)
      .mockReturnValueOnce(refill);
    const onError = vi.fn();
    const onSnapshotThread = vi.fn();
    const { result } = renderHook(() => useReadonlyThreadTimeline({ onError, onSnapshotThread, threadId: "thread-1" }));
    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Removed history"));
    const stream = FakeEventSource.instances[0];
    act(() => stream.emitNamed("thread_view.refresh_required", refreshRequiredEvent(2)));
    await waitFor(() => expect(getThreadDetail).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(getThreadDetail).mock.calls[1][1];
    const reset = threadDetail("", 3).timeline;
    act(() => {
      stream.emitNamed("thread_view.patch", { ...refreshRequiredEvent(3), kind: "thread_view.patch", payload: { ...reset, rows: [], turns: [], activeTurnId: null, liveState: "idle", scope: "full_snapshot", threadId: "thread-1", affectedTurnIds: [] } });
      stream.emitNamed("thread_view.refresh_required", { ...refreshRequiredEvent(3), payload: { threadId: "thread-1", reason: "thread_reverted" } });
    });
    await waitFor(() => expect(getThreadDetail).toHaveBeenCalledTimes(3));
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.timeline.rows).toHaveLength(0));
    expect(result.current.timeline.activeTurnId).toBeNull();
    await act(async () => {
      if (outcome === "success") release({ ...threadDetail("Removed history", 2), thread: { ...threadDetail("", 2).thread, name: "Obsolete before revert" } });
      else reject(new Error("Obsolete pre-revert failure"));
      await oldRead.catch(() => undefined);
    });
    expect(result.current.timeline.rows).toHaveLength(0);
    await act(async () => { releaseRefill(threadDetail("Kept history", 5)); await refill; });
    expect(timelineText(result.current.timeline)).toBe("Kept history");
    expect(onSnapshotThread).toHaveBeenCalledTimes(2);
    expect(onSnapshotThread).not.toHaveBeenCalledWith(expect.objectContaining({ name: "Obsolete before revert" }));
    expect(onError).not.toHaveBeenCalled();
    expect(attachThread).not.toHaveBeenCalled();
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
      parentThreadId: null, canAcceptDirectInput: null,
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
