import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { getThreadSettings, updateThreadSettings, type EventEnvelope, type ThreadSettingsResponse, type ThreadViewPatch } from "../api/client";
import { createKodexQueryClient } from "../api/queryClient";
import { applyThreadSettingsEvent } from "./threadSettingsCache";
import { useThreadSettings } from "./useThreadSettings";

vi.mock("../api/client", () => ({ getThreadSettings: vi.fn(), updateThreadSettings: vi.fn() }));
afterEach(() => vi.clearAllMocks());

const initial: ThreadSettingsResponse = { model: "native-model", effort: "medium", serviceTier: null, activePermissionProfile: null };

it("cancels an initial stale read on an applied marker and always reads current native settings for replayed markers", async () => {
  const client = createKodexQueryClient();
  let release!: (settings: ThreadSettingsResponse) => void;
  let staleSignal: AbortSignal | undefined;
  vi.mocked(getThreadSettings).mockImplementationOnce((_id, signal) => {
    staleSignal = signal;
    return new Promise((resolve) => { release = resolve; });
  }).mockResolvedValue({ ...initial, effort: "high", serviceTier: "fast" });
  const hook = renderHook(() => useThreadSettings("chat"), {
    wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(getThreadSettings).toHaveBeenCalledTimes(1));
  act(() => applyThreadSettingsEvent(client, { id: "applied", seq: 10, kind: "thread.settings_updated", threadId: "chat", payload: { threadId: "chat" }, receivedAt: "2026-10-04T00:00:00Z" }));
  await waitFor(() => expect(hook.result.current.settings).toMatchObject({ effort: "high", fast: true }));
  expect(staleSignal?.aborted).toBe(true);
  await act(async () => release(initial));
  expect(hook.result.current.settings).toMatchObject({ effort: "high", fast: true });

  vi.mocked(getThreadSettings).mockResolvedValue({ ...initial, model: "new-native-model" });
  act(() => applyThreadSettingsEvent(client, { id: "old-marker", seq: 2, kind: "thread.settings_updated", payload: { threadId: "chat" }, receivedAt: "2026-10-04T00:00:00Z" }));
  await waitFor(() => expect(hook.result.current.settings).toMatchObject({ model: "new-native-model", effort: "medium", fast: false }));
  expect(updateThreadSettings).not.toHaveBeenCalled();
});

it("replaces a pending pre-turn failure after the canonical active lifecycle arrives, without refetching later turns", async () => {
  const client = createKodexQueryClient();
  let failOld!: (error: Error) => void;
  let oldSignal: AbortSignal | undefined;
  vi.mocked(getThreadSettings).mockImplementationOnce((_id, signal) => {
    oldSignal = signal;
    return new Promise((_resolve, reject) => { failOld = reject; });
  }).mockResolvedValue({ ...initial, effort: "high", serviceTier: "fast" });
  const hook = renderHook(() => useThreadSettings("chat"), {
    wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
  await waitFor(() => expect(getThreadSettings).toHaveBeenCalledTimes(1));
  const patch: ThreadViewPatch = {
    scope: "lifecycle", threadId: "chat", activeTurnId: "first-turn", liveState: "streaming", viewRevision: 1,
    pendingApprovalRequests: [], pendingUserInputRequests: [],
  };
  const event: EventEnvelope = { id: "started", seq: 1, kind: "thread_view.patch", threadId: "chat", payload: patch, receivedAt: "2026-10-04T00:00:00Z" };
  await act(async () => {
    applyThreadSettingsEvent(client, { ...event, payload: { ...patch, activeTurnId: null } });
    applyThreadSettingsEvent(client, { ...event, payload: { ...patch, scope: "row_delta" } });
    applyThreadSettingsEvent(client, { ...event, threadId: "unobserved-chat" });
  });
  expect(getThreadSettings).toHaveBeenCalledTimes(1);
  act(() => applyThreadSettingsEvent(client, event));
  await waitFor(() => expect(hook.result.current.settings).toMatchObject({ effort: "high", fast: true }));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => failOld(new Error("502: no rollout found for thread id")));
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.settings).toMatchObject({ effort: "high", fast: true });
  await act(async () => applyThreadSettingsEvent(client, { ...event, id: "next-turn", seq: 2, payload: { ...patch, viewRevision: 2, activeTurnId: "second-turn" } }));
  expect(getThreadSettings).toHaveBeenCalledTimes(2);
  expect(updateThreadSettings).not.toHaveBeenCalled();
});
