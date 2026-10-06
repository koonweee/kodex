import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { APPEARANCE_STORAGE_KEY } from "./theme/appearancePreferences";
import type { ThreadSettingsResponse } from "./api/client";
import {
  App,
  FakeEventSource,
  baseRoutes,
  clickMenuItem as clickMenuItemWithDeps,
  highReasoningModel,
  model,
  mockGateway,
  project,
  requestJson,
  secondThread,
  thread,
  threadDetail,
} from "./test/mvpAppHarness";

function clickMenuItem(name: RegExp) {
  return clickMenuItemWithDeps(name, screen, waitFor, fireEvent);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function clickFastSwitch() {
  await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /fast/i, hidden: true }));
}

function rateLimitResetDate(daysFromToday: number, hour: number, minute: number) {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysFromToday, hour, minute);
}

function resetDateLabel(date: Date) {
  return new Intl.DateTimeFormat("en-US", { day: "2-digit", month: "short" }).format(date);
}

function streamIncludesThread(instance: FakeEventSource, threadId: string): boolean {
  const url = new URL(instance.url, "http://localhost");
  return (url.searchParams.get("threadIds") ?? "").split(",").includes(threadId);
}

function activeThreadPane() {
  const pane = document.querySelector<HTMLElement>('.kodex-thread-pane[data-workspace-pane-active="true"]');
  expect(pane).toBeInTheDocument();
  return pane as HTMLElement;
}

function getActiveComposer() {
  return within(activeThreadPane()).getByLabelText(/message composer/i);
}

function getActiveSendButton() {
  return within(activeThreadPane()).getByRole("button", { name: /send message/i });
}

function getActiveModelButton(name: RegExp) {
  return within(activeThreadPane()).getByRole("button", { name });
}

function alternateModel(id: string, isDefault = false) {
  return { ...model, id, model: id, displayName: id, isDefault };
}

function settingsFor(model: string, effort = "medium", serviceTier: string | null = null): ThreadSettingsResponse {
  return { model, effort, serviceTier, activePermissionProfile: null };
}

describe("MVP composer settings flows", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("saves sparse native model choices and sends input without replaying settings", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    const nativeSettings = settingsFor("gpt-5.4");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-1/settings": () => ({ ...nativeSettings }),
        "PATCH /v1/threads/thread-1/settings": async (request: Request) => {
          Object.assign(nativeSettings, await requestJson(request));
          return new Response("{}", { status: 202, headers: { "Content-Type": "application/json" } });
        },
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i });
    await waitFor(() => {
      expect(FakeEventSource.instances.some((instance) => streamIncludesThread(instance, "thread-1"))).toBe(true);
    });

    const threadStream = FakeEventSource.instances.find((instance) => streamIncludesThread(instance, "thread-1"));
    act(() => {
      threadStream?.emit({
        id: "usage-1",
        seq: 3,
        kind: "timeline.thread_metadata",
        codexMethod: "thread/tokenUsage/updated",
        projectId: project.id,
        threadId: thread.id,
        payload: {
          tokenUsage: {
            total: { totalTokens: 20_000 },
            last: { totalTokens: 20_000 },
            modelContextWindow: 28_000,
          },
        },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });
    expect(await screen.findByLabelText(/50% context left/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, medium/i }));
    await clickMenuItem(/^Reasoning$/i);
    await clickMenuItem(/^high$/i);
    await userEvent.click(await screen.findByRole("button", { name: /model: gpt-5\.4, high/i }));
    await clickFastSwitch();
    await waitFor(() => expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings")).toHaveLength(2));
    expect(await Promise.all(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings").map(requestJson)))
      .toEqual([{ effort: "high" }, { serviceTier: "fast" }]);
    expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(0);

    await userEvent.type(screen.getByLabelText(/message composer/i), "Use the selected controls");
    const sendButton = screen.getByRole("button", { name: /send message/i });
    await waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
    await userEvent.click(sendButton);
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });

    const turnBody = await requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0]);
    expect(turnBody).toEqual({
      clientUserMessageId: expect.any(String),
      input: [{ text: "Use the selected controls", type: "text" }],
    });
    // Theme and presence identity are browser-local; shared choices stay native.
    expect(storageSpy.mock.calls.filter(([key]) =>
      key !== APPEARANCE_STORAGE_KEY && key !== "kodex.threadViewPresenceClientId",
    )).toEqual([]);
  }, 20_000);

  it("reads native settings independently of stale thread metadata without resubmitting them", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const latestThread: Record<string, unknown> = {
      ...thread,
      model: "gpt-5.4",
      rawPayload: { model: "gpt-5.4", reasoningEffort: "medium" },
      reasoningEffort: "medium",
      serviceTier: null,
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/threads": { threads: [latestThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-1/settings": settingsFor("gpt-5.4", "xhigh"),
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4, xhigh/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Use app-server thread defaults");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });

    const turnBody = await requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0]);
    expect(turnBody).toEqual({
      clientUserMessageId: expect.any(String),
      input: [{ text: "Use app-server thread defaults", type: "text" }],
    });
  }, 20_000);

  it("does not show a global error banner when composer settings are unavailable on first load", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    window.history.replaceState(null, "", "/");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/composer-settings": undefined,
        "GET /v1/events": { events: [] },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i })).toBeInTheDocument();
    await waitFor(() => {
      // The query may retry an unavailable optional read; its count is not the behavior contract.
      expect(gateway.callsFor("GET", "/v1/composer-settings").length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText("Gateway request failed")).not.toBeInTheDocument();
  });

  it("uses last turn token usage instead of cumulative usage for context left", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
      }),
    );

    render(<App />);

    await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i });
    await waitFor(() => {
      expect(FakeEventSource.instances.some((instance) => streamIncludesThread(instance, "thread-1"))).toBe(true);
    });

    const threadStream = FakeEventSource.instances.find((instance) => streamIncludesThread(instance, "thread-1"));
    act(() => {
      threadStream?.emit({
        id: "usage-1",
        seq: 3,
        kind: "timeline.thread_metadata",
        codexMethod: "thread/tokenUsage/updated",
        projectId: project.id,
        threadId: thread.id,
        payload: {
          tokenUsage: {
            total: { totalTokens: 571_000 },
            last: { totalTokens: 25_000 },
            modelContextWindow: 258_000,
          },
        },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(await screen.findByLabelText(/95% context left/i)).toBeInTheDocument();
  });

  it("shows initial usage limits and updates them from account rate-limit notifications", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 4, 12, 0, 0));
    vi.stubGlobal("EventSource", FakeEventSource);
    const initialPrimaryReset = rateLimitResetDate(0, 14, 14);
    const initialSecondaryReset = rateLimitResetDate(3, 9, 0);
    const updatedPrimaryReset = rateLimitResetDate(0, 15, 30);
    const secondaryResetLabel = resetDateLabel(initialSecondaryReset);
    mockGateway(
      baseRoutes({
        "GET /v1/account/rate-limits": {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 18, resetsAt: initialPrimaryReset.getTime() / 1000, windowDurationMins: 300 },
            secondary: { usedPercent: 36, resetsAt: initialSecondaryReset.getTime() / 1000, windowDurationMins: 10_080 },
          },
          rateLimitsByLimitId: null,
          rawPayload: {},
        },
        "GET /v1/events": { events: [] },
      }),
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /account settings/i }));
    expect(await screen.findByText("5h 82% left - 2:14 PM")).toBeInTheDocument();
    expect(screen.getByText(`7d 64% left - 9:00 AM (${secondaryResetLabel})`)).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /5h 82% left/i })).not.toBeInTheDocument();

    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    act(() => {
      globalStream?.emitNamed("account.rate_limits_updated", {
        id: "rate-limit-update-1",
        seq: 5,
        kind: "account.rate_limits_updated",
        codexMethod: "account/rateLimits/updated",
        projectId: null,
        threadId: null,
        payload: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 7, resetsAt: updatedPrimaryReset.getTime() / 1000, windowDurationMins: 300 },
            secondary: { usedPercent: 21, resetsAt: initialSecondaryReset.getTime() / 1000, windowDurationMins: 10_080 },
          },
        },
        receivedAt: "2026-05-04T00:00:02Z",
      });
    });

    expect(await screen.findByText("5h 93% left - 3:30 PM")).toBeInTheDocument();
    expect(screen.getByText(`7d 79% left - 9:00 AM (${secondaryResetLabel})`)).toBeInTheDocument();
  });

  it("keeps live account rate-limit updates when the initial rate-limit snapshot resolves later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 4, 4, 12, 0, 0));
    vi.stubGlobal("EventSource", FakeEventSource);
    const stalePrimaryReset = rateLimitResetDate(0, 14, 14);
    const staleSecondaryReset = rateLimitResetDate(3, 9, 0);
    const livePrimaryReset = rateLimitResetDate(0, 15, 30);
    const secondaryResetLabel = resetDateLabel(staleSecondaryReset);
    let resolveRateLimits!: (response: unknown) => void;
    const delayedRateLimits = new Promise<unknown>((resolve) => {
      resolveRateLimits = resolve;
    });
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/account/rate-limits": () => delayedRateLimits,
        "GET /v1/events": { events: [] },
      }),
    );

    render(<App />);

    await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i });
    await waitFor(() => {
      expect(gateway.callsFor("GET", "/v1/account/rate-limits")).toHaveLength(1);
    });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    act(() => {
      globalStream?.emitNamed("account.rate_limits_updated", {
        id: "rate-limit-update-1",
        seq: 5,
        kind: "account.rate_limits_updated",
        codexMethod: "account/rateLimits/updated",
        projectId: null,
        threadId: null,
        payload: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 7, resetsAt: livePrimaryReset.getTime() / 1000, windowDurationMins: 300 },
            secondary: { usedPercent: 21, resetsAt: staleSecondaryReset.getTime() / 1000, windowDurationMins: 10_080 },
          },
        },
        receivedAt: "2026-05-04T00:00:02Z",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /account settings/i }));
    expect(await screen.findByText("5h 93% left - 3:30 PM")).toBeInTheDocument();

    await act(async () => {
      resolveRateLimits({
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 18, resetsAt: stalePrimaryReset.getTime() / 1000, windowDurationMins: 300 },
          secondary: { usedPercent: 36, resetsAt: staleSecondaryReset.getTime() / 1000, windowDurationMins: 10_080 },
        },
        rateLimitsByLimitId: null,
        rawPayload: {},
      });
      await delayedRateLimits;
    });

    await waitFor(() => {
      expect(screen.getByText("5h 93% left - 3:30 PM")).toBeInTheDocument();
      expect(screen.getByText(`7d 79% left - 9:00 AM (${secondaryResetLabel})`)).toBeInTheDocument();
      expect(screen.queryByText("5h 82% left - 2:14 PM")).not.toBeInTheDocument();
    });
  });

  it("forwards draft choices once to thread creation and sends the first input without settings", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "POST /v1/threads": { thread: { ...thread, id: "thread-2", name: "New thread", preview: null }, rawPayload: {} },
        "GET /v1/threads/thread-2/settings": settingsFor("gpt-5.4", "high", "fast"),
        "POST /v1/threads/thread-2/input": { payload: {} },
      }),
    );

    render(<App />);

    await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i });
    await userEvent.click(screen.getByRole("button", { name: /^new thread$/i }));
    await userEvent.click(getActiveModelButton(/model: gpt-5\.4, medium/i));
    await clickMenuItem(/^Model$/i);
    await clickMenuItem(/^gpt-5\.4$/i);
    await userEvent.click(getActiveModelButton(/model: gpt-5\.4, medium/i));
    await clickMenuItem(/^Reasoning$/i);
    await clickMenuItem(/^high$/i);
    await userEvent.click(getActiveModelButton(/model: gpt-5\.4, high/i));
    await clickFastSwitch();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(0);

    await userEvent.type(getActiveComposer(), "Start with toolbar settings");
    const sendButton = getActiveSendButton();
    await waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
    await userEvent.click(sendButton);
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(1);
    });

    const createThreadBody = await requestJson(gateway.callsFor("POST", "/v1/threads")[0]);
    expect(createThreadBody).toMatchObject({
      effort: "high",
      projectId: project.id,
      model: "gpt-5.4",
      serviceTier: "fast",
    });
    const inputBody = await requestJson(gateway.callsFor("POST", "/v1/threads/thread-2/input")[0]);
    expect(inputBody).toEqual({
      clientUserMessageId: expect.any(String),
      input: [{ type: "text", text: "Start with toolbar settings" }],
    });
    expect(createThreadBody).not.toHaveProperty("permissions");
    expect(inputBody).not.toHaveProperty("permissions");
  });

  it("uses global composer defaults when creating a chat from project-scoped defaults", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const chatThread = {
      ...thread,
      projectId: null,
      id: "chat-thread-1",
      name: "New thread",
      cwd: "/home/example/Documents/Codex/2026-05-05/global-defaults",
      preview: "",
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/composer-settings": (request: Request) => {
          const projectId = new URL(request.url).searchParams.get("projectId");
          return projectId === project.id
            ? { model: "gpt-5.4", effort: "high", serviceTier: "fast", permissionProfileId: "auto-review" }
            : { model: null, effort: null, serviceTier: null, permissionProfileId: null };
        },
        "POST /v1/chats/threads": { thread: chatThread, rawPayload: {} },
        "POST /v1/threads/chat-thread-1/attach": threadDetail(chatThread),
        "GET /v1/threads/chat-thread-1/settings": settingsFor("gpt-5.4"),
        "POST /v1/threads/chat-thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    await userEvent.click(screen.getByRole("button", { name: /^new chat$/i }));
    await userEvent.type(getActiveComposer(), "Use global defaults");
    await userEvent.click(getActiveSendButton());

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/chats/threads")).toHaveLength(1);
    });
    const body = await requestJson(gateway.callsFor("POST", "/v1/chats/threads")[0]);
    expect(body).toMatchObject({ firstMessageText: "Use global defaults" });
    expect(body).not.toHaveProperty("model");
    expect(body).not.toHaveProperty("serviceTier");
    expect(body).not.toHaveProperty("permissions");

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/chat-thread-1/input")).toHaveLength(1);
    });
    const turnBody = await requestJson(gateway.callsFor("POST", "/v1/threads/chat-thread-1/input")[0]);
    expect(turnBody).not.toHaveProperty("model");
    expect(turnBody).not.toHaveProperty("effort");
    expect(turnBody).not.toHaveProperty("serviceTier");
    expect(turnBody).not.toHaveProperty("permissions");
  });

  it("sends existing chat input without guessed settings while native settings are loading", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const nativeSettings = deferred<ThreadSettingsResponse>();
    const chatThread = {
      ...thread,
      projectId: null,
      id: "chat-thread-1",
      name: "Chat without settings",
      cwd: "/home/example/Documents/Codex/2026-05-05/chat-without-settings",
      preview: "No thread-specific settings",
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/threads/chat-thread-1/settings": () => nativeSettings.promise,
        "GET /v1/chats/threads": { threads: [chatThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "POST /v1/threads/chat-thread-1/attach": threadDetail(chatThread),
        "POST /v1/threads/chat-thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^chat without settings$/i }));
    expect(await within(activeThreadPane()).findByRole("button", { name: "Loading chat settings" })).toBeDisabled();
    await userEvent.type(getActiveComposer(), "Send before native settings load");
    await userEvent.click(getActiveSendButton());

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/chat-thread-1/input")).toHaveLength(1);
    });
    const turnBody = await requestJson(gateway.callsFor("POST", "/v1/threads/chat-thread-1/input")[0]);
    expect(turnBody).toEqual({ clientUserMessageId: expect.any(String), input: [{ type: "text", text: "Send before native settings load" }] });
    expect(gateway.callsFor("GET", "/v1/threads/chat-thread-1/settings")).toHaveLength(1);
    await act(async () => nativeSettings.resolve(settingsFor("gpt-5.4", "high", "fast")));
    expect(await within(activeThreadPane()).findByRole("button", { name: /model: gpt-5\.4, high/i })).toBeInTheDocument();
  });

  it("reads native settings for a resumed chat instead of new-chat defaults", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/composer-settings": {
          model: "gpt-5.4",
          effort: "medium",
          serviceTier: null,
          permissionProfileId: null,
        },
        "GET /v1/threads/thread-1/settings": settingsFor("gpt-5.4", "high", "fast"),
        "GET /v1/threads": {
          threads: [{ ...thread, status: "notLoaded" }],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-1/attach": threadDetail({
          ...thread,
          reasoningEffort: "high",
          serviceTier: "fast",
          activePermissionProfile: { id: "auto-review" },
        }),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4, high/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
  });

  it("restores thread-specific model settings when switching between threads", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/settings": settingsFor("gpt-5.4mini"),
        "GET /v1/threads/thread-2/settings": settingsFor("gpt-5.3spark"),
        "GET /v1/models": {
          models: [
            alternateModel("gpt-5.4mini", true),
            alternateModel("gpt-5.3spark"),
          ],
          nextCursor: null,
          rawPayload: {},
        },
        "GET /v1/threads": {
          threads: [
            {
              ...thread,
              name: "mini",
              model: "gpt-5.4mini",
              reasoningEffort: "medium",
              serviceTier: null,
              rawPayload: {},
            },
            {
              ...secondThread,
              name: "spark",
              model: "gpt-5.3spark",
              reasoningEffort: "medium",
              serviceTier: null,
              rawPayload: {},
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4mini, medium/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "spark" }));
    await waitFor(() => expect(getActiveModelButton(/model: gpt-5\.3spark, medium/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "mini" }));
    await waitFor(() => expect(getActiveModelButton(/model: gpt-5\.4mini, medium/i)).toBeInTheDocument());
  });

  it("loads native settings when the selected thread has no model metadata", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/settings": settingsFor("gpt-5.4-mini"),
        "GET /v1/threads/thread-2/settings": settingsFor("gpt-5.4", "high"),
        "GET /v1/models": {
          models: [
            highReasoningModel,
            alternateModel("gpt-5.4-mini"),
          ],
          nextCursor: null,
          rawPayload: {},
        },
        "GET /v1/threads": {
          threads: [
            {
              ...thread,
              name: "mini",
              model: "gpt-5.4-mini",
              reasoningEffort: "medium",
              serviceTier: null,
              rawPayload: {},
            },
            {
              ...secondThread,
              name: "plain",
              model: undefined,
              reasoningEffort: undefined,
              serviceTier: undefined,
              rawPayload: {},
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4-mini, medium/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "plain" }));
    await waitFor(() => {
      expect(getActiveModelButton(/model: gpt-5\.4, high/i)).toBeInTheDocument();
    });
  });

  it("reloads native settings for newly created chats across selection and remount", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const miniThread = {
      ...thread,
      id: "thread-mini",
      name: "mini",
      preview: "",
      rawPayload: {},
    };
    const sparkThread = {
      ...thread,
      id: "thread-spark",
      name: "spark",
      preview: "",
      rawPayload: {},
    };
    const createdThreads = [miniThread, sparkThread];
    const serverThreads: typeof createdThreads = [];
    let createThreadIndex = 0;
    const modelRoutes = {
      models: [
        highReasoningModel,
        alternateModel("gpt-5.4-mini"),
        alternateModel("gpt-5.3-codex-spark"),
      ],
      nextCursor: null,
      rawPayload: {},
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": modelRoutes,
        "GET /v1/threads": () => ({
          threads: serverThreads,
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        }),
        "POST /v1/threads/thread-mini/attach": () => threadDetail(createdThreads[0]),
        "POST /v1/threads/thread-spark/attach": () => threadDetail(createdThreads[1]),
        "GET /v1/threads/thread-mini/settings": settingsFor("gpt-5.4-mini"),
        "GET /v1/threads/thread-spark/settings": settingsFor("gpt-5.3-codex-spark"),
        "POST /v1/threads": () => {
          const createdThread = createdThreads[createThreadIndex++];
          serverThreads.unshift(createdThread);
          return { thread: createdThread, rawPayload: {} };
        },
        "POST /v1/threads/thread-mini/input": { payload: {} },
        "POST /v1/threads/thread-spark/input": { payload: {} },
      }),
    );

    const { unmount } = render(<App />);

    await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i });
    const projectGroup = await screen.findByRole("group", { name: "Kodex" });
    await userEvent.click(within(projectGroup).getByRole("button", { name: /create thread in kodex|new thread/i }));
    await userEvent.click(getActiveModelButton(/model: gpt-5\.4, medium/i));
    await clickMenuItem(/^Model$/i);
    await clickMenuItem(/^gpt-5\.4-mini$/i);
    expect(await screen.findByRole("button", { name: /model: gpt-5\.4-mini, medium/i })).toBeInTheDocument();
    await userEvent.type(getActiveComposer(), "mini");
    await userEvent.click(getActiveSendButton());
    expect(await screen.findByRole("heading", { name: /^mini$/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^new thread$/i }));
    await userEvent.click(getActiveModelButton(/model: gpt-5\.4, medium/i));
    await clickMenuItem(/^Model$/i);
    await clickMenuItem(/^gpt-5\.3-codex-spark$/i);
    expect(await screen.findByRole("button", { name: /model: gpt-5\.3-codex-spark, medium/i })).toBeInTheDocument();
    await userEvent.type(getActiveComposer(), "spark");
    await userEvent.click(getActiveSendButton());
    expect(await screen.findByRole("heading", { name: /^spark$/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^mini$/i }));
    await waitFor(() => expect(getActiveModelButton(/model: gpt-5\.4-mini, medium/i)).toBeInTheDocument());

    unmount();
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /^spark$/i }));
    await waitFor(() => expect(getActiveModelButton(/model: gpt-5\.3-codex-spark, medium/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /^mini$/i }));
    await waitFor(() => expect(getActiveModelButton(/model: gpt-5\.4-mini, medium/i)).toBeInTheDocument());

    expect(await Promise.all(gateway.callsFor("POST", "/v1/threads").map(requestJson)))
      .toEqual([
        expect.objectContaining({ model: "gpt-5.4-mini" }),
        expect.objectContaining({ model: "gpt-5.3-codex-spark" }),
      ]);
    expect(gateway.callsFor("GET", "/v1/threads/thread-mini/settings").length).toBeGreaterThanOrEqual(2);
    expect(gateway.callsFor("GET", "/v1/threads/thread-spark/settings").length).toBeGreaterThanOrEqual(2);
  });

  it("shows sidebar account settings without model or status summaries", async () => {
    mockGateway(
      baseRoutes({
        "POST /v1/account/logout": { payload: {} },
      }),
    );

    render(<App />);

    const sidebar = screen.getByRole("navigation", { name: /workspace/i });
    expect(within(sidebar).queryByLabelText(/model/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /status/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /debug options/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /account settings/i })).toBeInTheDocument();
    expect(screen.queryByText(/used/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect chatgpt/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /account settings/i }));
    expect(await screen.findByRole("menuitem", { hidden: true, name: /automations/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { hidden: true, name: /preferences/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { hidden: true, name: /show debug events/i })).toBeInTheDocument();
  });

});
