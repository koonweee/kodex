import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GatewayRequestError, markThreadSeen, type ThreadRead, type ThreadSummary } from "../api/client";
import type { TimelineTurn } from "../timeline/state";
import { useThreadReadState } from "./useThreadReadState";

vi.mock("../api/client", async (importActual) => ({
  ...await importActual<typeof import("../api/client")>(), markThreadSeen: vi.fn(),
}));

const thread: ThreadSummary = {
  id: "outside-sidebar", name: "Canonical deep link", projectId: null, cwd: "/repo",
  parentThreadId: null, canAcceptDirectInput: true, status: "idle", createdAt: 1, updatedAt: 1,
  notificationsEnabled: true, rawPayload: {}, latestCompletedTurnId: "turn-a", seenCompletedTurnId: null,
  readRevision: 10, readStateKnown: true, unreadCompletedAgentTurn: true,
};
const terminal: TimelineTurn = { turnId: "turn-a", itemIds: [], status: "completed" };
const seen: ThreadRead = {
  threadId: thread.id, latestCompletedTurnId: "turn-a", seenCompletedTurnId: "turn-a",
  readRevision: 11, readStateKnown: true, unreadCompletedAgentTurn: false, updatedAt: "2026-10-05T00:00:00Z",
};
const callbacks = () => ({ onRead: vi.fn(), onRefresh: vi.fn(), onError: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(markThreadSeen).mockResolvedValue(seen);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => vi.restoreAllMocks());

describe("canonical visible completion acknowledgment", () => {
  it("acknowledges an exact canonical deep-link completion only while its pane and document are visible", async () => {
    const handlers = callbacks();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { rerender } = renderHook(({ isVisible }) => useThreadReadState({
      thread, turns: [terminal], isVisible, ...handlers,
    }), { initialProps: { isVisible: false } });
    expect(markThreadSeen).not.toHaveBeenCalled();
    rerender({ isVisible: true });
    expect(markThreadSeen).not.toHaveBeenCalled();
    act(() => { visibility.mockReturnValue("visible"); document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(markThreadSeen).toHaveBeenCalledWith(thread.id, { completedTurnId: "turn-a", readRevision: 10 }));
    await waitFor(() => expect(handlers.onRead).toHaveBeenCalledWith(seen));
    rerender({ isVisible: true });
    expect(markThreadSeen).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge a summary head until that terminal turn is in the canonical pane", async () => {
    const handlers = callbacks();
    const { rerender } = renderHook(({ turns, current }) => useThreadReadState({
      thread: current, turns, isVisible: true, ...handlers,
    }), { initialProps: { turns: [] as TimelineTurn[], current: thread } });
    expect(markThreadSeen).not.toHaveBeenCalled();
    rerender({ turns: [{ ...terminal, status: "inProgress" }], current: thread });
    expect(markThreadSeen).not.toHaveBeenCalled();
    rerender({ turns: [terminal], current: { ...thread, readStateKnown: false } });
    expect(markThreadSeen).not.toHaveBeenCalled();
    rerender({ turns: [terminal], current: thread });
    await waitFor(() => expect(markThreadSeen).toHaveBeenCalledTimes(1));
  });

  it("refills after a stale revision conflict without automatically acknowledging a different unseen head", async () => {
    const handlers = callbacks();
    vi.mocked(markThreadSeen).mockRejectedValueOnce(new GatewayRequestError("Stale completion", 409));
    const { rerender } = renderHook(({ current, turns }) => useThreadReadState({
      thread: current, turns, isVisible: true, ...handlers,
    }), { initialProps: { current: thread, turns: [terminal] } });
    await waitFor(() => expect(handlers.onRefresh).toHaveBeenCalledTimes(1));
    expect(handlers.onRead).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    rerender({ current: { ...thread }, turns: [terminal] });
    expect(markThreadSeen).toHaveBeenCalledTimes(1);
    rerender({ current: { ...thread, latestCompletedTurnId: "turn-b", readRevision: 12 }, turns: [terminal] });
    expect(markThreadSeen).toHaveBeenCalledTimes(1);
    rerender({ current: { ...thread, latestCompletedTurnId: "turn-b", readRevision: 12 }, turns: [{ ...terminal, turnId: "turn-b" }] });
    await waitFor(() => expect(markThreadSeen).toHaveBeenLastCalledWith(thread.id, { completedTurnId: "turn-b", readRevision: 12 }));
  });

  it("does not apply an old acknowledgment or error to a replaced pane", async () => {
    const handlers = callbacks();
    let reject!: (error: unknown) => void;
    vi.mocked(markThreadSeen).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const { rerender } = renderHook(({ current }) => useThreadReadState({
      thread: current, turns: [terminal], isVisible: true, ...handlers,
    }), { initialProps: { current: thread } });
    await waitFor(() => expect(markThreadSeen).toHaveBeenCalledTimes(1));
    rerender({ current: { ...thread, id: "different-chat", latestCompletedTurnId: null, unreadCompletedAgentTurn: false } });
    await act(async () => reject(new GatewayRequestError("Old conflict", 409)));
    expect(handlers.onRefresh).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onRead).not.toHaveBeenCalled();
  });

  it("allows the same exact receipt on a later foreground transition after a failed write without retrying on render", async () => {
    const handlers = callbacks();
    vi.mocked(markThreadSeen).mockRejectedValueOnce(new TypeError("Offline"));
    const { rerender } = renderHook(() => useThreadReadState({ thread, turns: [terminal], isVisible: true, ...handlers }));
    await waitFor(() => expect(handlers.onError).toHaveBeenCalledTimes(1));
    rerender();
    expect(markThreadSeen).toHaveBeenCalledTimes(1);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(markThreadSeen).toHaveBeenCalledTimes(2));
    expect(vi.mocked(markThreadSeen).mock.calls.map((call) => call[1])).toEqual([
      { completedTurnId: "turn-a", readRevision: 10 }, { completedTurnId: "turn-a", readRevision: 10 },
    ]);
    await waitFor(() => expect(handlers.onRead).toHaveBeenCalledWith(seen));
  });

  it("retries an unacknowledged exact tuple after an authoritative reconnect snapshot with unchanged values", async () => {
    const handlers = callbacks();
    vi.mocked(markThreadSeen).mockRejectedValueOnce(new TypeError("Offline"));
    const { rerender } = renderHook(({ snapshot }) => useThreadReadState({ thread: snapshot, turns: [terminal], isVisible: true, ...handlers }),
      { initialProps: { snapshot: thread } });
    await waitFor(() => expect(handlers.onError).toHaveBeenCalledTimes(1));
    rerender({ snapshot: thread });
    expect(markThreadSeen).toHaveBeenCalledTimes(1);
    rerender({ snapshot: { ...thread } });
    await waitFor(() => expect(markThreadSeen).toHaveBeenCalledTimes(2));
    expect(markThreadSeen).toHaveBeenLastCalledWith(thread.id, { completedTurnId: "turn-a", readRevision: 10 });
  });
});
