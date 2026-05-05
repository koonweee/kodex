import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  FakeEventSource,
  activeThread,
  appCss,
  baseRoutes,
  clickMenuItem as clickMenuItemWithDeps,
  highReasoningModel,
  mockGateway,
  project,
  requestJson,
  secondThread,
  thread,
  timelineElement,
} from "./test/mvpAppHarness";

function clickMenuItem(name: RegExp) {
  return clickMenuItemWithDeps(name, screen, waitFor, fireEvent);
}

async function clickFastSwitch() {
  await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /fast/i, hidden: true }));
}

describe("MVP composer settings flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("sends composer footer model, speed, permissions, and context settings", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/turns": { payload: {} },
      }),
    );

    render(<App />);

    const modelButton = await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i });
    await waitFor(() => {
      expect(FakeEventSource.instances.some((instance) => instance.url.includes("threadId=thread-1"))).toBe(true);
    });

    const threadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    act(() => {
      threadStream?.emit({
        id: "usage-1",
        seq: 3,
        kind: "codex.notification",
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
    await userEvent.click(screen.getByRole("button", { name: /permissions: default permissions/i }));
    await clickMenuItem(/full access/i);
    expect(screen.getByRole("button", { name: /permissions: default permissions/i })).toBeInTheDocument();
    await clickMenuItem(/confirm full access/i);
    expect(await screen.findByRole("button", { name: /permissions: full access/i })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/message composer/i), "Use the selected controls");
    const sendButton = screen.getByRole("button", { name: /send message/i });
    await waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
    await userEvent.click(sendButton);
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
    });

    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/turns")[0])).resolves.toMatchObject({
      model: "gpt-5.4",
      effort: "high",
      serviceTier: "fast",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("hydrates and persists composer model effort and fast mode without browser storage or permission writes", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const storageSpy = vi.spyOn(Storage.prototype, "setItem");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/composer-settings": {
          model: "gpt-5.4",
          effort: "high",
          serviceTier: "fast",
          permissionsPreset: "autoReview",
        },
        "GET /v1/events": { events: [] },
        "PATCH /v1/composer-settings": { saved: true },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4, high/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /permissions: auto review/i })).toBeInTheDocument();
    expect(appCss).toMatch(/\.kodex-composer-model-control\s*\{[^}]*width:\s*fit-content;/s);
    expect(appCss).toMatch(/\.kodex-composer-model-control\s*\{[^}]*max-width:\s*none;/s);
    expect(appCss).toMatch(/\.kodex-composer-control\s+\.mantine-Button-label\s*\{[^}]*overflow:\s*visible;/s);

    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, high/i }));
    await clickMenuItem(/^medium$/i);
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, medium/i }));
    await clickFastSwitch();
    await userEvent.click(screen.getByRole("button", { name: /permissions: auto review/i }));
    await clickMenuItem(/default permissions/i);

    await waitFor(() => {
      expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(2);
    });
    await expect(requestJson(gateway.callsFor("PATCH", "/v1/composer-settings")[0])).resolves.toEqual({
      effort: "medium",
    });
    await expect(requestJson(gateway.callsFor("PATCH", "/v1/composer-settings")[1])).resolves.toEqual({
      serviceTier: null,
    });
    expect(storageSpy).not.toHaveBeenCalled();
  });

  it("does not show a global error banner when composer settings are unavailable on first load", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
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

  it("shows composer-local save failure instead of a global banner when model setting persistence fails", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "GET /v1/events": { events: [] },
        "PATCH /v1/composer-settings": undefined,
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i }));
    await clickMenuItem(/^high$/i);

    await waitFor(() => {
      expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(1);
    });
    expect(await screen.findByLabelText(/composer settings were not saved/i)).toBeInTheDocument();
    expect(screen.queryByText("Gateway request failed")).not.toBeInTheDocument();
  });

  it("uses last turn token usage instead of cumulative usage for context left", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
      }),
    );

    render(<App />);

    await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i });
    await waitFor(() => {
      expect(FakeEventSource.instances.some((instance) => instance.url.includes("threadId=thread-1"))).toBe(true);
    });

    const threadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    act(() => {
      threadStream?.emit({
        id: "usage-1",
        seq: 3,
        kind: "codex.notification",
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
    vi.stubGlobal("EventSource", FakeEventSource);
    const initialPrimaryReset = new Date(2026, 4, 4, 14, 14);
    const initialSecondaryReset = new Date(2026, 4, 7, 9, 0);
    const updatedPrimaryReset = new Date(2026, 4, 4, 15, 30);
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
    expect(screen.getByText("7d 64% left - 9:00 AM (May 07)")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /5h 82% left/i })).not.toBeInTheDocument();

    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    act(() => {
      globalStream?.emitNamed("codex.notification", {
        id: "rate-limit-update-1",
        seq: 5,
        kind: "codex.notification",
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
    expect(screen.getByText("7d 79% left - 9:00 AM (May 07)")).toBeInTheDocument();
  });

  it("keeps live account rate-limit updates when the initial rate-limit snapshot resolves later", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const stalePrimaryReset = new Date(2026, 4, 4, 14, 14);
    const staleSecondaryReset = new Date(2026, 4, 7, 9, 0);
    const livePrimaryReset = new Date(2026, 4, 4, 15, 30);
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
      globalStream?.emitNamed("codex.notification", {
        id: "rate-limit-update-1",
        seq: 5,
        kind: "codex.notification",
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
      expect(screen.getByText("7d 79% left - 9:00 AM (May 07)")).toBeInTheDocument();
      expect(screen.queryByText("5h 82% left - 2:14 PM")).not.toBeInTheDocument();
    });
  });

  it("forwards draft thread composer settings to thread start and first turn", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/models": { models: [highReasoningModel], nextCursor: null, rawPayload: {} },
        "POST /v1/threads": { thread: { ...thread, id: "thread-2", name: "New thread", preview: null }, rawPayload: {} },
        "POST /v1/threads/thread-2/turns": { payload: {} },
      }),
    );

    render(<App />);

    await screen.findByRole("button", { name: /model: gpt-5\.4, medium/i });
    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, medium/i }));
    await clickMenuItem(/^high$/i);
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, high/i }));
    await clickFastSwitch();
    await userEvent.click(screen.getByRole("button", { name: /permissions: default permissions/i }));
    await clickMenuItem(/auto review/i);
    expect(await screen.findByRole("button", { name: /permissions: auto review/i })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/message composer/i), "Start with toolbar settings");
    const sendButton = screen.getByRole("button", { name: /send message/i });
    await waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
    await userEvent.click(sendButton);
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/turns")).toHaveLength(1);
    });

    await expect(requestJson(gateway.callsFor("POST", "/v1/threads")[0])).resolves.toMatchObject({
      projectId: project.id,
      model: "gpt-5.4",
      serviceTier: "fast",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-2/turns")[0])).resolves.toMatchObject({
      effort: "high",
      serviceTier: "fast",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: false, writableRoots: [] },
    });
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
          permissionsPreset: "default",
        },
        "GET /v1/threads": {
          threads: [{ ...thread, status: "notLoaded" }],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-1/resume": {
          thread: {
            ...thread,
            reasoningEffort: "high",
            serviceTier: "fast",
            approvalsReviewer: "auto_review",
          },
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4, high/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /permissions: auto review/i })).toBeInTheDocument();
  });

  it("shows sidebar login without model or status summaries", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/account/login": {
          loginType: "chatgpt",
          loginId: "login-1",
          authUrl: "https://chatgpt.com/login/device",
          verificationUrl: null,
          userCode: null,
          rawPayload: {},
        },
        "POST /v1/account/login/login-1/cancel": { payload: {} },
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
    await userEvent.click(screen.getByRole("button", { name: /connect chatgpt/i }));

    expect(await screen.findByRole("link", { name: /open chatgpt auth/i })).toHaveAttribute(
      "href",
      "https://chatgpt.com/login/device",
    );
    expect(gateway.callsFor("POST", "/v1/account/login")).toHaveLength(1);

    await userEvent.click(screen.getByRole("button", { name: /cancel login/i }));
    expect(gateway.callsFor("POST", "/v1/account/login/login-1/cancel")).toHaveLength(1);
  });

});
