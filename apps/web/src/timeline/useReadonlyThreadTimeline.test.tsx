import { compactCanonicalPayload } from "../test/canonicalPayloadFixture";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { attachThread, getThreadDetail, type EventEnvelope, type ThreadTimelineRow, type ThreadViewPatch, type ThreadViewResponse } from "../api/client";
import { ThreadDeliveryProvider } from "./ThreadDeliveryPreferences";
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

  it("updates per-tab delivery preferences without a history refill and applies them to the next ordinary read", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(getThreadDetail).mockReset().mockResolvedValue(threadDetail("Stored history", 1));
    let enabled = false;
    const wrapper = ({ children }: { children: ReactNode }) => <ThreadDeliveryProvider includeDebugEvents={enabled} includeCommandOutputs={enabled}>{children}</ThreadDeliveryProvider>;
    const first = renderHook(() => useReadonlyThreadTimeline({ onError: vi.fn(), threadId: "thread-1" }), { wrapper });
    const second = renderHook(() => useReadonlyThreadTimeline({ onError: vi.fn(), threadId: "thread-1" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(getThreadDetail).toHaveBeenCalledTimes(2);
    const otherStream = FakeEventSource.instances[1];
    enabled = true;
    first.rerender();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(3));
    expect(getThreadDetail).toHaveBeenCalledTimes(2);
    expect(otherStream.closed).toBe(false);
    expect(timelineText(first.result.current.timeline)).toBe("Stored history");
    expect(timelineText(second.result.current.timeline)).toBe("Stored history");
    const url = new URL(FakeEventSource.instances[2].url, window.location.origin);
    expect(url.searchParams.get("includeDebugEvents")).toBe("true");
    expect(url.searchParams.get("includeCommandOutputs")).toBe("true");
    act(() => FakeEventSource.instances[2].emitNamed("thread_view.refresh_required", refreshRequiredEvent(2)));
    await waitFor(() => expect(getThreadDetail).toHaveBeenCalledTimes(3));
    expect(vi.mocked(getThreadDetail).mock.calls[2][2]).toEqual({ includeDebugEvents: true, includeCommandOutputs: true });
    enabled = false;
    first.rerender();
    expect(getThreadDetail).toHaveBeenCalledTimes(3);
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

  it.each(["lifecycle", "row_delta"] as const)("refills text overtaken by a partial %s patch without refilling old events again", async (scope) => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let release!: (snapshot: ThreadViewResponse) => void;
    const refill = new Promise<ThreadViewResponse>((resolve) => { release = resolve; });
    vi.mocked(getThreadDetail).mockReset().mockResolvedValue(threadDetail("Base", 1));
    const onError = vi.fn();
    const { result } = renderHook(() => useReadonlyThreadTimeline({ onError, threadId: "thread-1" }), { wrapper: StrictMode });
    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Base"));
    const initialReads = vi.mocked(getThreadDetail).mock.calls.length;
    vi.mocked(getThreadDetail).mockReturnValue(refill);
    const row = threadDetail("Pending input", 3).timeline.rows![0];
    const pendingRow: ThreadTimelineRow = {
      ...row, id: "pending-row", kind: "user_message", displayOrder: 2,
      item: {
        ...row.item!, id: "pending-input", itemId: "pending-input", itemType: "userMessage", displayOrder: 2,
        payload: compactCanonicalPayload({ id: "pending-input", type: "userMessage", content: [{ type: "text", text: "Pending input" }] }, { id: "pending-input", itemType: "userMessage", clientId: "pending-client" }),
      },
    };
    const partial: ThreadViewPatch = {
      scope, threadId: "thread-1", viewRevision: 3, liveState: "streaming", activeTurnId: "turn-1",
      pendingApprovalRequests: [], pendingUserInputRequests: [],
      ...(scope === "row_delta" ? { rows: [pendingRow], affectedTurnIds: ["turn-1"] } : {}),
    };
    const stream = FakeEventSource.instances[0];
    const partialEvent = { ...refreshRequiredEvent(4), kind: "thread_view.patch", payload: partial };
    act(() => stream.emitNamed("thread_view.patch", partialEvent));
    await waitFor(() => expect(result.current.timeline.viewRevision).toBe(3));

    // The newer partial patch does not contain this earlier native text.
    const delayed = itemDeltaEvent({ delta: " A", seq: 2 });
    act(() => stream.emitNamed("thread_view.item_delta", delayed));
    await waitFor(() => expect(getThreadDetail).toHaveBeenCalledTimes(initialReads + 1));
    expect(vi.mocked(getThreadDetail).mock.calls[initialReads][1]?.aborted).toBe(false);
    expect(timelineText(result.current.timeline)).not.toContain("Base A");

    const canonical = threadDetail("Base A", 3);
    if (scope === "row_delta") canonical.timeline.rows!.push(pendingRow);
    await act(async () => { release(canonical); await refill; });
    expect(timelineText(result.current.timeline)).toBe(scope === "row_delta" ? "Base APending input" : "Base A");
    act(() => {
      stream.emitNamed("thread_view.patch", { ...partialEvent, seq: 20 });
      stream.emitNamed("thread_view.item_delta", { ...delayed, seq: 21 });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    expect(getThreadDetail).toHaveBeenCalledTimes(initialReads + 1);
    expect(attachThread).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("starts a new recovery for a newer uncovered partial while the earlier StrictMode refill is held", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(getThreadDetail).mockReset().mockResolvedValue(threadDetail("Base", 1));
    const onError = vi.fn();
    const { result } = renderHook(() => useReadonlyThreadTimeline({ onError, threadId: "thread-1" }), { wrapper: StrictMode });
    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Base"));
    const initialReads = vi.mocked(getThreadDetail).mock.calls.length;
    let releaseEarlier!: (snapshot: ThreadViewResponse) => void;
    let releaseNewer!: (snapshot: ThreadViewResponse) => void;
    const earlier = new Promise<ThreadViewResponse>((resolve) => { releaseEarlier = resolve; });
    const newer = new Promise<ThreadViewResponse>((resolve) => { releaseNewer = resolve; });
    vi.mocked(getThreadDetail).mockReturnValueOnce(earlier).mockReturnValue(newer);
    const stream = FakeEventSource.instances[0];
    const lifecycle = (revision: number): EventEnvelope => ({
      ...refreshRequiredEvent(revision), kind: "thread_view.patch",
      payload: {
        scope: "lifecycle", threadId: "thread-1", viewRevision: revision,
        liveState: "streaming", activeTurnId: "turn-1", pendingApprovalRequests: [], pendingUserInputRequests: [],
      },
    });
    act(() => stream.emitNamed("thread_view.patch", lifecycle(3)));
    await waitFor(() => expect(result.current.timeline.viewRevision).toBe(3));
    act(() => stream.emitNamed("thread_view.item_delta", itemDeltaEvent({ delta: " A", seq: 2 })));
    await waitFor(() => expect(getThreadDetail).toHaveBeenCalledTimes(initialReads + 1));
    const earlierSignal = vi.mocked(getThreadDetail).mock.calls[initialReads][1];
    expect(earlierSignal?.aborted).toBe(false);

    act(() => stream.emitNamed("thread_view.patch", lifecycle(5)));
    await waitFor(() => expect(result.current.timeline.viewRevision).toBe(5));
    act(() => stream.emitNamed("thread_view.item_delta", itemDeltaEvent({ delta: " B", seq: 4 })));
    await waitFor(() => expect(getThreadDetail).toHaveBeenCalledTimes(initialReads + 2));
    expect(earlierSignal?.aborted).toBe(true);
    expect(vi.mocked(getThreadDetail).mock.calls[initialReads + 1][1]?.aborted).toBe(false);
    await act(async () => { releaseEarlier(threadDetail("Base A", 3)); await earlier; });
    expect(timelineText(result.current.timeline)).toBe("Base");
    await act(async () => { releaseNewer(threadDetail("Base A B", 5)); await newer; });
    expect(timelineText(result.current.timeline)).toBe("Base A B");
    act(() => stream.emitNamed("thread_view.item_delta", itemDeltaEvent({ delta: " B", seq: 4 })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    expect(getThreadDetail).toHaveBeenCalledTimes(initialReads + 2);
    expect(onError).not.toHaveBeenCalled();
    expect(attachThread).not.toHaveBeenCalled();
  });

  it("does not retry a failed committed refill on rerender, but recovers from a later uncovered event", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(getThreadDetail).mockReset().mockResolvedValue(threadDetail("Base", 1));
    const onError = vi.fn();
    const { result, rerender } = renderHook(() => useReadonlyThreadTimeline({ onError, threadId: "thread-1" }), { wrapper: StrictMode });
    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Base"));
    const initialReads = vi.mocked(getThreadDetail).mock.calls.length;
    vi.mocked(getThreadDetail).mockRejectedValue(new Error("Native read unavailable"));
    const stream = FakeEventSource.instances[0];
    const lifecycle = (revision: number): EventEnvelope => ({
      ...refreshRequiredEvent(revision), kind: "thread_view.patch",
      payload: {
        scope: "lifecycle", threadId: "thread-1", viewRevision: revision,
        liveState: "streaming", activeTurnId: "turn-1", pendingApprovalRequests: [], pendingUserInputRequests: [],
      },
    });
    act(() => stream.emitNamed("thread_view.patch", lifecycle(3)));
    await waitFor(() => expect(result.current.timeline.viewRevision).toBe(3));
    act(() => stream.emitNamed("thread_view.item_delta", itemDeltaEvent({ delta: " A", seq: 2 })));
    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    rerender();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    expect(getThreadDetail).toHaveBeenCalledTimes(initialReads + 1);
    expect(timelineText(result.current.timeline)).toBe("Base");

    vi.mocked(getThreadDetail).mockResolvedValue(threadDetail("Base A B", 5));
    act(() => stream.emitNamed("thread_view.patch", lifecycle(5)));
    await waitFor(() => expect(result.current.timeline.viewRevision).toBe(5));
    act(() => stream.emitNamed("thread_view.item_delta", itemDeltaEvent({ delta: " B", seq: 4 })));
    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Base A B"));
    expect(getThreadDetail).toHaveBeenCalledTimes(initialReads + 2);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(attachThread).not.toHaveBeenCalled();
  });

  it("finishes an outstanding repair when a valid newer delta overtakes its held snapshot", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.mocked(getThreadDetail).mockReset().mockResolvedValue(threadDetail("Base", 1));
    const onError = vi.fn();
    const { result } = renderHook(() => useReadonlyThreadTimeline({ onError, threadId: "thread-1" }));
    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Base"));
    let releaseEarlier!: (snapshot: ThreadViewResponse) => void;
    let releaseNewer!: (snapshot: ThreadViewResponse) => void;
    const earlier = new Promise<ThreadViewResponse>((resolve) => { releaseEarlier = resolve; });
    const newer = new Promise<ThreadViewResponse>((resolve) => { releaseNewer = resolve; });
    vi.mocked(getThreadDetail).mockReturnValueOnce(earlier).mockReturnValue(newer);
    const stream = FakeEventSource.instances[0];
    act(() => stream.emitNamed("thread_view.patch", {
      ...refreshRequiredEvent(3), kind: "thread_view.patch",
      payload: {
        scope: "lifecycle", threadId: "thread-1", viewRevision: 3,
        liveState: "streaming", activeTurnId: "turn-1", pendingApprovalRequests: [], pendingUserInputRequests: [],
      },
    }));
    await waitFor(() => expect(result.current.timeline.viewRevision).toBe(3));
    act(() => stream.emitNamed("thread_view.item_delta", itemDeltaEvent({ delta: " A", seq: 2 })));
    await waitFor(() => expect(getThreadDetail).toHaveBeenCalledTimes(2));
    const earlierSignal = vi.mocked(getThreadDetail).mock.calls[1][1];

    // This delta is appendable, but does not fill the missing earlier text. It
    // makes the held R3 response stale, so recovery still needs a fresh R4 read.
    act(() => stream.emitNamed("thread_view.item_delta", itemDeltaEvent({ delta: " B", seq: 4 })));
    await waitFor(() => expect(timelineText(result.current.timeline)).toBe("Base B"));
    await waitFor(() => expect(getThreadDetail).toHaveBeenCalledTimes(3));
    expect(earlierSignal?.aborted).toBe(true);
    await act(async () => { releaseEarlier(threadDetail("Base A", 3)); await earlier; });
    expect(timelineText(result.current.timeline)).toBe("Base B");
    await act(async () => { releaseNewer(threadDetail("Base A B", 4)); await newer; });
    expect(timelineText(result.current.timeline)).toBe("Base A B");
    act(() => stream.emitNamed("thread_view.item_delta", itemDeltaEvent({ delta: " B", seq: 4 })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
    expect(getThreadDetail).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
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
    payload: compactCanonicalPayload({ id: "agent-1", type: "agentMessage", text }, { id: "agent-1", itemType: "agentMessage" }),
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
      notificationsEnabled: true, pinned: false,
      createdAt: 1777500000,
      latestCompletedTurnId: null,
      seenCompletedTurnId: null,
      readRevision: 0,
      readStateKnown: false,
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
