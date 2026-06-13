import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  FakeEventSource,
  baseRoutes,
  clickMenuItem as clickMenuItemWithDeps,
  highReasoningModel,
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
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /fast/i, hidden: true }));
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

describe("MVP composer settings flows", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("sends composer footer model, speed, and context settings as next-send options without permission overrides", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let latestThread: Record<string, unknown> = { ...thread, model: "gpt-5.4", reasoningEffort: "medium", serviceTier: null, rawPayload: {} };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/threads": { threads: [latestThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
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
    await clickMenuItem(/^high$/i);
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, high/i }));
    await clickFastSwitch();
    expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings")).toHaveLength(0);
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
    expect(turnBody).toMatchObject({
      effort: "high",
      input: [{ text: "Use the selected controls", type: "text" }],
      model: "gpt-5.4",
      serviceTier: "fast",
    });
    expect(turnBody).not.toHaveProperty("permissions");
  }, 20_000);

  it("includes selected-thread turn options from rendered composer settings", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const latestThread: Record<string, unknown> = {
      ...thread,
      model: "gpt-5.4",
      rawPayload: { model: "gpt-5.4", reasoningEffort: "xhigh" },
      reasoningEffort: "xhigh",
      serviceTier: null,
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/threads": { threads: [latestThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
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
      effort: "xhigh",
      input: [{ text: "Use app-server thread defaults", type: "text" }],
      model: "gpt-5.4",
    });
  }, 20_000);

  it("hydrates and updates composer model effort and fast mode without browser storage or permission writes", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    let latestThread: Record<string, unknown> = { ...thread, model: "gpt-5.4", reasoningEffort: "high", serviceTier: "fast", rawPayload: {} };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/threads": { threads: [latestThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/composer-settings": {
          model: "gpt-5.4",
          effort: "high",
          serviceTier: "fast",
          permissionProfileId: null,
        },
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4, high/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, high/i }));
    await clickMenuItem(/^medium$/i);
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, medium/i }));
    await clickFastSwitch();
    expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings")).toHaveLength(0);
    expect(storageSpy).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/message composer/i), "Use normal speed");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });

    const turnBody = await requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0]);
    expect(turnBody).toMatchObject({
      effort: "medium",
      input: [{ text: "Use normal speed", type: "text" }],
      model: "gpt-5.4",
      serviceTier: null,
    });
  });

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
      expect(gateway.callsFor("GET", "/v1/composer-settings")).toHaveLength(1);
    });
    expect(screen.queryByText("Gateway request failed")).not.toBeInTheDocument();
  });

  it("does not persist pane picker changes or show a save failure before submit", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/events": { events: [] },
        "PATCH /v1/threads/thread-1/settings": undefined,
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i }));
    await clickMenuItem(/^high$/i);

    expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings")).toHaveLength(0);
    expect(screen.queryByLabelText(/thread settings were not saved/i)).not.toBeInTheDocument();
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

  it("forwards draft thread composer settings to thread start and first turn", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "POST /v1/threads": { thread: { ...thread, id: "thread-2", name: "New thread", preview: null }, rawPayload: {} },
        "POST /v1/threads/thread-2/input": { payload: {} },
      }),
    );

    render(<App />);

    await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i });
    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    await userEvent.click(getActiveModelButton(/model: gpt-5\.4, medium/i));
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
    expect(inputBody).toMatchObject({
      effort: "high",
      serviceTier: "fast",
    });
    expect(createThreadBody).not.toHaveProperty("permissions");
    expect(inputBody).not.toHaveProperty("permissions");
  });

  it("uses global composer defaults when creating a chat from project-scoped defaults", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const chatThread = {
      ...thread,
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
        "GET /v1/threads/chat-thread-1": threadDetail(chatThread),
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

  it("hydrates global composer defaults when selecting an existing chat without a snapshot", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const chatThread = {
      ...thread,
      id: "chat-thread-1",
      name: "Chat without settings",
      cwd: "/home/example/Documents/Codex/2026-05-05/chat-without-settings",
      preview: "No thread-specific settings",
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
        "GET /v1/chats/threads": { threads: [chatThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/chat-thread-1": threadDetail(chatThread),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /chat without settings/i }));

    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/composer-settings").some((request) => !new URL(request.url).searchParams.has("projectId"))).toBe(true);
  });

  it("uses default chat settings for an immediate send after selecting a chat while global hydration is delayed", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const globalSettings = deferred<{
      model: null;
      effort: null;
      serviceTier: null;
    }>();
    const chatThread = {
      ...thread,
      id: "chat-thread-1",
      name: "Chat without settings",
      cwd: "/home/example/Documents/Codex/2026-05-05/chat-without-settings",
      preview: "No thread-specific settings",
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/composer-settings": (request: Request) => {
          const projectId = new URL(request.url).searchParams.get("projectId");
          return projectId === project.id
            ? { model: "gpt-5.4", effort: "high", serviceTier: "fast", permissionProfileId: "auto-review" }
            : globalSettings.promise;
        },
        "GET /v1/chats/threads": { threads: [chatThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/chat-thread-1": threadDetail(chatThread),
        "POST /v1/threads/chat-thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /chat without settings/i }));
    await userEvent.type(getActiveComposer(), "Send before global hydration");
    await userEvent.click(getActiveSendButton());

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/chat-thread-1/input")).toHaveLength(1);
    });
    const turnBody = await requestJson(gateway.callsFor("POST", "/v1/threads/chat-thread-1/input")[0]);
    expect(turnBody).not.toHaveProperty("model");
    expect(turnBody).not.toHaveProperty("effort");
    expect(turnBody).not.toHaveProperty("serviceTier");
    expect(turnBody).not.toHaveProperty("permissions");
    expect(gateway.callsFor("GET", "/v1/composer-settings").some((request) => !new URL(request.url).searchParams.has("projectId"))).toBe(true);
  });

  it("uses resumed thread composer state before durable new-thread defaults", async () => {
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
        "GET /v1/threads": {
          threads: [{ ...thread, status: "notLoaded" }],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-1/attach": {
          disposition: "resumed",
          thread: {
            ...thread,
            reasoningEffort: "high",
            serviceTier: "fast",
            activePermissionProfile: { id: "auto-review" },
          },
          rawPayload: {},
        },
        "GET /v1/threads/thread-1": threadDetail({
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
        "GET /v1/models": {
          models: [
            {
              id: "gpt-5.4mini",
              model: "gpt-5.4mini",
              displayName: "GPT-5.4 Mini",
              description: "Fast coding model",
              defaultReasoningEffort: "medium",
              hidden: false,
              inputModalities: ["text"],
              isDefault: true,
              rawPayload: {},
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
              upgrade: null,
            },
            {
              id: "gpt-5.3spark",
              model: "gpt-5.3spark",
              displayName: "GPT-5.3 Spark",
              description: "Balanced coding model",
              defaultReasoningEffort: "medium",
              hidden: false,
              inputModalities: ["text"],
              isDefault: false,
              rawPayload: {},
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
              upgrade: null,
            },
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
    expect(getActiveModelButton(/model: gpt-5\.3spark, medium/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "mini" }));
    expect(getActiveModelButton(/model: gpt-5\.4mini, medium/i)).toBeInTheDocument();
  });

  it("falls back to durable defaults when the selected thread has no model metadata", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/models": {
          models: [
            highReasoningModel,
            {
              id: "gpt-5.4-mini",
              model: "gpt-5.4-mini",
              displayName: "GPT-5.4 Mini",
              description: "Fast coding model",
              defaultReasoningEffort: "medium",
              hidden: false,
              inputModalities: ["text"],
              isDefault: false,
              rawPayload: {},
              supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
              upgrade: null,
            },
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
      expect(getActiveModelButton(/model: gpt-5\.4, medium/i)).toBeInTheDocument();
    });
  });

  it("restores model settings for newly created threads from gateway create metadata", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const miniThread = {
      ...thread,
      id: "thread-mini",
      name: "mini",
      preview: "",
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      rawPayload: {},
    };
    const sparkThread = {
      ...thread,
      id: "thread-spark",
      name: "spark",
      preview: "",
      model: "gpt-5.3-codex-spark",
      reasoningEffort: "medium",
      rawPayload: {},
    };
    const createdThreads = [miniThread, sparkThread];
    const serverThreads: typeof createdThreads = [];
    let createThreadIndex = 0;
    const modelRoutes = {
      models: [
        highReasoningModel,
        {
          id: "gpt-5.4-mini",
          model: "gpt-5.4-mini",
          displayName: "GPT-5.4 Mini",
          description: "Fast coding model",
          defaultReasoningEffort: "medium",
          hidden: false,
          inputModalities: ["text"],
          isDefault: false,
          rawPayload: {},
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
          upgrade: null,
        },
        {
          id: "gpt-5.3-codex-spark",
          model: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3 Spark",
          description: "Small coding model",
          defaultReasoningEffort: "medium",
          hidden: false,
          inputModalities: ["text"],
          isDefault: false,
          rawPayload: {},
          supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
          upgrade: null,
        },
      ],
      nextCursor: null,
      rawPayload: {},
    };
    mockGateway(
      baseRoutes({
        "GET /v1/models": modelRoutes,
        "GET /v1/threads": () => ({
          threads: serverThreads,
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        }),
        "GET /v1/threads/thread-mini": () => threadDetail(createdThreads[0]),
        "GET /v1/threads/thread-spark": () => threadDetail(createdThreads[1]),
        "POST /v1/threads/thread-mini/attach": () => ({
          disposition: "resumed",
          thread: createdThreads[0],
          rawPayload: {},
        }),
        "POST /v1/threads/thread-spark/attach": () => ({
          disposition: "resumed",
          thread: createdThreads[1],
          rawPayload: {},
        }),
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
    await userEvent.click(await screen.findByRole("button", { name: /create thread in kodex/i }));
    await userEvent.click(getActiveModelButton(/model: gpt-5\.4, medium/i));
    await clickMenuItem(/^gpt-5\.4-mini$/i);
    expect(await screen.findByRole("button", { name: /model: gpt-5\.4-mini, medium/i })).toBeInTheDocument();
    await userEvent.type(getActiveComposer(), "mini");
    await userEvent.click(getActiveSendButton());
    expect(await screen.findByRole("heading", { name: /^mini$/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    await userEvent.click(getActiveModelButton(/model: gpt-5\.4, medium/i));
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
  });

  it("replaces local next-send thread settings from refreshed metadata in two clients", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const models = [
      highReasoningModel,
      {
        id: "gpt-5.4-mini",
        model: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        description: "Fast coding model",
        defaultReasoningEffort: "medium",
        hidden: false,
        inputModalities: ["text"],
        isDefault: false,
        rawPayload: {},
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        upgrade: null,
      },
      {
        id: "gpt-5.3spark",
        model: "gpt-5.3spark",
        displayName: "GPT-5.3 Spark",
        description: "Balanced coding model",
        defaultReasoningEffort: "medium",
        hidden: false,
        inputModalities: ["text"],
        isDefault: false,
        rawPayload: {},
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        upgrade: null,
      },
    ];
    const initialThread = {
      ...thread,
      model: "gpt-5.4",
      reasoningEffort: "medium",
      serviceTier: null,
      rawPayload: {},
    };
    const refreshedThread = {
      ...initialThread,
      model: "gpt-5.3spark",
      updatedAt: initialThread.updatedAt + 1,
      rawPayload: { model: "gpt-5.3spark", reasoningEffort: "medium" },
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models, nextCursor: null, rawPayload: {} },
        "GET /v1/threads": {
          threads: [initialThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/threads/thread-1": threadDetail(initialThread),
      }),
    );

    const firstClient = render(<App />);
    const secondClient = render(<App />);

    expect(
      await within(firstClient.container).findByRole("button", { name: /model: gpt-5\.4, medium/i }),
    ).toBeInTheDocument();
    expect(
      await within(secondClient.container).findByRole("button", { name: /model: gpt-5\.4, medium/i }),
    ).toBeInTheDocument();

    await userEvent.click(within(firstClient.container).getByRole("button", { name: /model: gpt-5\.4, medium/i }));
    await clickMenuItem(/^gpt-5\.4-mini$/i);
    expect(
      await within(firstClient.container).findByRole("button", { name: /model: gpt-5\.4-mini, medium/i }),
    ).toBeInTheDocument();
    expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/settings")).toHaveLength(0);

    const selectedThreadStreams = FakeEventSource.instances.filter((instance) => streamIncludesThread(instance, "thread-1"));
    expect(selectedThreadStreams).toHaveLength(2);
    act(() => {
      for (const stream of selectedThreadStreams) {
        stream.emitNamed("timeline.thread_metadata", {
          id: `event-refreshed-${stream.url}`,
          seq: 12,
          kind: "timeline.thread_metadata",
          codexMethod: "thread/metadata",
          projectId: project.id,
          threadId: thread.id,
          payload: { thread: refreshedThread },
          receivedAt: "2026-05-15T00:00:00Z",
        });
      }
    });

    expect(
      await within(firstClient.container).findByRole("button", { name: /model: gpt-5\.3spark, medium/i }),
    ).toBeInTheDocument();
    expect(
      await within(secondClient.container).findByRole("button", { name: /model: gpt-5\.3spark, medium/i }),
    ).toBeInTheDocument();
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
