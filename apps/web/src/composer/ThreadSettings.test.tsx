import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import type { EventEnvelope, ThreadSettingsUpdateRequest, ThreadViewPatch } from "../api/client";
import { App, FakeEventSource, baseRoutes, highReasoningModel, mockGateway, requestJson, thread, threadDetail } from "../test/mvpAppHarness";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); FakeEventSource.instances.length = 0; });

it("shares native applied settings across clients while disjoint stale picker intents preserve each other", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  let nativeSettings = { model: highReasoningModel.id, effort: "medium", serviceTier: null as string | null, activePermissionProfile: null };
  const patches: ThreadSettingsUpdateRequest[] = [];
  const gateway = mockGateway(baseRoutes({
    "GET /v1/models": { models: [highReasoningModel], rawPayload: {} },
    "GET /v1/threads/thread-1": threadDetail({ ...thread, model: highReasoningModel.id, reasoningEffort: "medium", serviceTier: null }),
    "GET /v1/threads/thread-1/settings": () => ({ ...nativeSettings }),
    "PATCH /v1/threads/thread-1/settings": async (request: Request) => {
      patches.push(await requestJson(request) as ThreadSettingsUpdateRequest);
      return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
    },
  }));
  render(<><section aria-label="First client"><App /></section><section aria-label="Second client"><App /></section></>);
  const first = within(screen.getByRole("region", { name: "First client" }));
  const second = within(screen.getByRole("region", { name: "Second client" }));
  await first.findByRole("button", { name: "Model: gpt-5.4, medium" });
  await second.findByRole("button", { name: "Model: gpt-5.4, medium" });
  await waitFor(() => expect(FakeEventSource.instances.filter((source) => !source.closed)).toHaveLength(2));
  const streams = FakeEventSource.instances.filter((source) => !source.closed);

  await userEvent.click(first.getByRole("button", { name: "Model: gpt-5.4, medium" }));
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Fast" }));
  await waitFor(() => expect(patches).toEqual([{ serviceTier: "fast" }]));
  expect(first.queryByRole("img", { name: "Fast responses enabled" })).not.toBeInTheDocument();

  nativeSettings = { ...nativeSettings, serviceTier: "fast" };
  act(() => streams[0].emit(settingsChanged(1)));
  expect(await first.findByRole("img", { name: "Fast responses enabled" })).toBeInTheDocument();
  expect(second.queryByRole("img", { name: "Fast responses enabled" })).not.toBeInTheDocument();

  await userEvent.click(second.getByRole("button", { name: "Model: gpt-5.4, medium" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "High" }));
  await waitFor(() => expect(patches).toEqual([{ serviceTier: "fast" }, { effort: "high" }]));
  nativeSettings = { ...nativeSettings, effort: "high" };
  act(() => { for (const stream of streams) stream.emit(settingsChanged(2)); });
  for (const client of [first, second]) {
    expect(await client.findByRole("button", { name: "Model: gpt-5.4, high" })).toBeInTheDocument();
    expect(client.getByRole("img", { name: "Fast responses enabled" })).toBeInTheDocument();
  }
  expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(0);
});

it("recovers unavailable fresh-chat settings only after a canonical first-turn lifecycle notification", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  let persisted = false;
  const gateway = mockGateway(baseRoutes({
    "GET /v1/threads/thread-1/settings": () => persisted
      ? { model: highReasoningModel.id, effort: "high", serviceTier: "fast", activePermissionProfile: null }
      : new Response(JSON.stringify({ code: "app_server_error", message: "No rollout found for fresh native chat", retryable: false }), { status: 502, headers: { "content-type": "application/json" } }),
  }));
  render(<App />);
  expect(await screen.findByRole("button", { name: "Chat settings unavailable" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: /^Model:/ })).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("No rollout found for fresh native chat");
  await waitFor(() => expect(FakeEventSource.instances.some((stream) => !stream.closed)).toBe(true));
  const patch: ThreadViewPatch = {
    scope: "lifecycle", threadId: thread.id, activeTurnId: "first-native-turn", liveState: "streaming", viewRevision: 10,
    pendingApprovalRequests: [], pendingUserInputRequests: [], turns: [{ id: "first-native-turn", status: "inProgress" }],
  };
  persisted = true;
  act(() => FakeEventSource.instances.find((stream) => !stream.closed)?.emit({
    id: "first-turn-started", seq: 10, kind: "thread_view.patch", threadId: thread.id, payload: patch, receivedAt: "2026-10-04T00:00:00Z",
  }));
  expect(await screen.findByRole("button", { name: "Model: gpt-5.4, high" })).toBeInTheDocument();
  expect(screen.getByRole("img", { name: "Fast responses enabled" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(gateway.callsFor("GET", "/v1/threads/thread-1/settings")).toHaveLength(2);
  expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings")).toHaveLength(0);
});

function settingsChanged(seq: number): EventEnvelope {
  return { id: `settings-${seq}`, seq, kind: "thread.settings_updated", codexMethod: "thread/settings/updated", threadId: thread.id,
    projectId: thread.projectId, turnId: null, itemId: null, receivedAt: "2026-10-04T00:00:00Z", payload: { threadId: thread.id } };
}
