import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { mockGateway, requestJson } from "./test/gatewayMock";

const appCss = readFileSync(join(process.cwd(), "src/App.css"), "utf8");

const capabilities = {
  gateway: {
    version: "0.1.0",
    sse: true,
    approvals: true,
    gatewayAuth: false,
    trustedNetworkOnly: true,
  },
  appServer: {
    ready: true,
    experimentalApi: true,
  },
};

const project = {
  id: "project-1",
  name: "Kodex",
  cwd: "/home/example/kodex",
  createdAt: "2026-04-30T00:00:00Z",
  updatedAt: "2026-04-30T00:00:00Z",
};

const thread = {
  id: "thread-1",
  name: "Implement frontend",
  cwd: "/home/example/kodex",
  status: "idle",
  source: "local",
  preview: "Scaffold the web client",
  rawPayload: {},
  createdAt: 1777500000,
  updatedAt: 1777501200,
};

const activeThread = { ...thread, status: "active" };
const secondThread = {
  ...thread,
  id: "thread-2",
  name: "Second thread",
  preview: "A second thread",
};

const model = {
  id: "gpt-5.4",
  model: "gpt-5.4",
  displayName: "GPT-5.4",
  description: "General coding model",
  defaultReasoningEffort: "medium",
  hidden: false,
  inputModalities: ["text"],
  isDefault: true,
  rawPayload: {},
  supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
  upgrade: null,
};

const highReasoningModel = {
  ...model,
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced" },
    { reasoningEffort: "high", description: "Deeper reasoning" },
  ],
};

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }
}

function baseRoutes(overrides = {}) {
  return {
    "GET /v1/capabilities": capabilities,
    "GET /v1/projects": { projects: [project] },
    "GET /v1/threads": { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
    "GET /v1/events": {
      events: [
        {
          id: "event-1",
          seq: 1,
          kind: "codex",
          codexMethod: "item/agentMessage/delta",
          projectId: project.id,
          threadId: thread.id,
          turnId: "turn-1",
          itemId: "item-1",
          payload: { delta: "Hello from Codex" },
          receivedAt: "2026-04-30T00:00:00Z",
        },
      ],
    },
    "GET /v1/approvals": { approvals: [] },
    "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    "GET /v1/account/rate-limits": { rateLimits: null, rateLimitsByLimitId: null, rawPayload: {} },
    "GET /v1/models": { models: [model], nextCursor: null, rawPayload: {} },
    "GET /v1/composer-settings": { model: null, effort: null, serviceTier: null, permissionsPreset: null },
    ...overrides,
  };
}

function timelineElement(container: HTMLElement) {
  const element = container.querySelector<HTMLElement>(".kodex-timeline-scroll");
  expect(element).not.toBeNull();
  return element!;
}

async function clickMenuItem(name: RegExp) {
  let item: HTMLElement | undefined;
  await waitFor(() => {
    item = screen.queryAllByRole("menuitem", { hidden: true }).find((element) => name.test(element.textContent ?? ""));
    expect(item).toBeInTheDocument();
  });
  expect(item).toBeInTheDocument();
  fireEvent.click(item!);
}

describe("MVP frontend flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("renders projects and threads, creates a project, and promotes a draft thread title from the first message", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveCreatedThreadEvents: (value: unknown) => void = () => {};
    const createdThreadEvents = new Promise<unknown>((resolve) => {
      resolveCreatedThreadEvents = resolve;
    });
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/projects": async (request: Request) => ({
          ...(await requestJson(request)),
          id: "project-2",
          name: "Scratch",
          createdAt: "2026-04-30T00:00:00Z",
          updatedAt: "2026-04-30T00:00:00Z",
        }),
        "GET /v1/events": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("threadId") === "thread-2"
            ? createdThreadEvents
            : {
                events: [
                  {
                    id: "event-1",
                    seq: 1,
                    kind: "codex",
                    codexMethod: "item/agentMessage/delta",
                    projectId: project.id,
                    threadId: thread.id,
                    turnId: "turn-1",
                    itemId: "item-1",
                    payload: { delta: "Hello from Codex" },
                    receivedAt: "2026-04-30T00:00:00Z",
                  },
                ],
              };
        },
        "POST /v1/threads": { thread: { ...thread, id: "thread-2", name: "New thread", preview: null }, rawPayload: {} },
        "POST /v1/threads/thread-2/turns": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /kodex \/home\/example\/kodex/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /new project/i }));
    await userEvent.type(screen.getByLabelText(/project name/i), "Scratch");
    await userEvent.type(screen.getByLabelText(/working directory/i), "/tmp/scratch");
    await userEvent.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/projects")).toHaveLength(1);
    });

    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: /new thread/i })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: /new thread/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBeEnabled();

    await userEvent.type(screen.getByLabelText(/message composer/i), "Implement the next milestone for the web client");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/turns")).toHaveLength(1);
    });
    const optimisticThread = await screen.findByRole("button", {
      name: /implement the next milestone for the web client/i,
    });
    expect(
      within(optimisticThread).getByText("Implement the next milestone for the web client"),
    ).not.toHaveAttribute("data-placeholder-title");
    expect(screen.getByRole("heading", { name: /implement the next milestone for the web client/i })).toBeInTheDocument();

    act(() => {
      resolveCreatedThreadEvents({
        events: [
          {
            id: "event-title",
            seq: 2,
            kind: "codex.notification",
            codexMethod: "thread/nameUpdated",
            projectId: project.id,
            threadId: "thread-2",
            payload: { threadId: "thread-2", threadName: "Implement the next milestone" },
            receivedAt: "2026-04-30T00:00:01Z",
          },
        ],
      });
    });

    const titledThread = await screen.findByRole("button", { name: /implement the next milestone/i });
    expect(within(titledThread).getByText("Implement the next milestone")).not.toHaveAttribute("data-placeholder-title");
    expect(screen.getByRole("heading", { name: /implement the next milestone/i })).toBeInTheDocument();
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
    await clickMenuItem(/high.*deeper reasoning/i);
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, high/i }));
    await clickMenuItem(/^fast$/i);
    await userEvent.click(screen.getByRole("button", { name: /permissions: default permissions/i }));
    await clickMenuItem(/full access/i);
    expect(screen.getByRole("button", { name: /permissions: default permissions/i })).toBeInTheDocument();
    await clickMenuItem(/confirm full access/i);

    await userEvent.type(screen.getByLabelText(/message composer/i), "Use the selected controls");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
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

    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, high/i }));
    await clickMenuItem(/medium.*balanced/i);
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, medium/i }));
    await clickMenuItem(/^fast$/i);
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
    await clickMenuItem(/high.*deeper reasoning/i);

    await waitFor(() => {
      expect(gateway.callsFor("PATCH", "/v1/composer-settings")).toHaveLength(1);
    });
    expect(await screen.findByLabelText(/composer settings were not saved/i)).toBeInTheDocument();
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
    await clickMenuItem(/high.*deeper reasoning/i);
    await userEvent.click(screen.getByRole("button", { name: /model: gpt-5\.4, high/i }));
    await clickMenuItem(/^fast$/i);
    await userEvent.click(screen.getByRole("button", { name: /permissions: default permissions/i }));
    await clickMenuItem(/auto review/i);

    await userEvent.type(screen.getByLabelText(/message composer/i), "Start with toolbar settings");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
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

  it("derives full access from app-server sandbox policy objects on active threads", async () => {
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
            model: "gpt-5.4",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandbox: { type: "dangerFullAccess" },
          },
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /permissions: full access/i })).toBeInTheDocument();
  });

  it("uses preview text as the display title for unnamed threads", async () => {
    const unnamedThread = {
      ...thread,
      id: "019de25f-9ac3-72b1-adf6-a108f82d1fb6",
      name: null,
      preview: "reference the Codex desktop app UI and identify improvements",
    };
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [unnamedThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /reference the codex desktop app ui/i })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /reference the codex desktop app ui/i })).toBeInTheDocument();
    expect(screen.queryByText("019de25f-9ac3-72b1-adf6-a108f82d1fb6")).not.toBeInTheDocument();
  });

  it("groups threads under their projects in the sidebar", async () => {
    const otherProject = {
      ...project,
      id: "project-2",
      name: "Scratch",
      cwd: "/tmp/scratch",
    };
    mockGateway(
      baseRoutes({
        "GET /v1/projects": { projects: [project, otherProject] },
        "GET /v1/threads": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("projectId") === "project-2"
            ? {
                threads: [{ ...secondThread, projectId: "project-2" }],
                nextCursor: null,
                backwardsCursor: null,
                rawPayload: {},
              }
            : { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
      }),
    );

    render(<App />);

    const kodexGroup = await screen.findByRole("group", { name: /kodex/i });
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();

    const scratchGroup = await screen.findByRole("group", { name: /scratch/i });
    expect(within(scratchGroup).getByRole("button", { name: /second thread/i })).toBeInTheDocument();
  });

  it("marks threads that need approval and renders their approvals inside the thread", async () => {
    const blockedThread = {
      ...secondThread,
      status: "waitingOnApproval",
    };
    const unanchoredApproval = {
      id: "approval-thread-owned",
      requestId: "request-thread-owned",
      threadId: blockedThread.id,
      turnId: "turn-2",
      itemId: "missing-item",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo test", cwd: "/home/example/kodex", reason: "Verify changes" },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, blockedThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/approvals": { approvals: [unanchoredApproval] },
        "GET /v1/events": {
          events: [
            {
              id: "event-second-thread-message",
              seq: 1,
              kind: "codex",
              codexMethod: "item/agentMessage/delta",
              projectId: project.id,
              threadId: blockedThread.id,
              turnId: "turn-2",
              itemId: "item-visible",
              payload: { delta: "Waiting for approval" },
              receivedAt: "2026-04-30T00:00:00Z",
            },
          ],
        },
      }),
    );

    render(<App />);

    const blockedThreadButton = await screen.findByRole("button", { name: /second thread/i });
    expect(within(blockedThreadButton).getByText(/needs approval/i)).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /approvals/i })).not.toBeInTheDocument();

    await userEvent.click(blockedThreadButton);

    const threadView = await screen.findByRole("main", { name: /thread/i });
    expect(await within(threadView).findByText(/cargo test/i)).toBeInTheDocument();
    expect(within(threadView).getByText(/reason: verify changes/i)).toBeInTheDocument();
  });

  it("shows compact thread actions without fork or path subtitle", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/threads/thread-1/archive": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const main = await screen.findByRole("main", { name: /thread/i });
    expect(within(main).queryByText(project.cwd)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /fork thread/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /archive thread/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /archive thread/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/archive")).toHaveLength(1);
    });
  });

  it("hides thread loading state and resumes not-loaded threads on selection", async () => {
    const notLoadedThread = {
      ...secondThread,
      status: "notLoaded",
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, notLoadedThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/events": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("threadId") === "thread-2"
            ? {
                events: [
                  {
                    id: "event-2",
                    seq: 1,
                    kind: "codex",
                    codexMethod: "item/agentMessage/delta",
                    projectId: project.id,
                    threadId: "thread-2",
                    turnId: "turn-2",
                    itemId: "item-2",
                    payload: { delta: "Replay after resume" },
                    receivedAt: "2026-04-30T00:00:01Z",
                  },
                ],
              }
            : baseRoutes()["GET /v1/events"];
        },
        "POST /v1/threads/thread-2/resume": {
          thread: { ...notLoadedThread, status: "idle" },
          rawPayload: {},
        },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resume thread/i })).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-thread-status")).not.toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/resume")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/resume")).toHaveLength(1);
    });
    expect(await screen.findByText(/replay after resume/i)).toBeInTheDocument();
  });

  it("provides a compact panel switcher for narrow viewports", async () => {
    mockGateway(baseRoutes());

    render(<App />);

    const panelSwitcher = await screen.findByRole("tablist", { name: /mobile panels/i });
    expect(within(panelSwitcher).getByRole("tab", { name: /threads/i })).toHaveAttribute("aria-selected", "false");
    expect(within(panelSwitcher).getByRole("tab", { name: /chat/i })).toHaveAttribute("aria-selected", "true");
    expect(within(panelSwitcher).queryByRole("tab", { name: /approvals/i })).not.toBeInTheDocument();

    await userEvent.click(within(panelSwitcher).getByRole("tab", { name: /threads/i }));
    expect(within(panelSwitcher).getByRole("tab", { name: /threads/i })).toHaveAttribute("aria-selected", "true");
  });

  it("clears the old active thread immediately after creating a project", async () => {
    let resolveNewProjectThreads: (value: unknown) => void = () => undefined;
    const newProjectThreads = new Promise((resolve) => {
      resolveNewProjectThreads = resolve;
    });
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("projectId") === "project-2"
            ? newProjectThreads
            : { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
        "POST /v1/projects": async (request: Request) => ({
          ...(await requestJson(request)),
          id: "project-2",
          name: "Scratch",
          createdAt: "2026-04-30T00:00:00Z",
          updatedAt: "2026-04-30T00:00:00Z",
        }),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new project/i }));
    await userEvent.type(screen.getByLabelText(/project name/i), "Scratch");
    await userEvent.type(screen.getByLabelText(/working directory/i), "/tmp/scratch");
    await userEvent.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/projects")).toHaveLength(1);
    });
    expect(screen.getByLabelText(/message composer/i)).toBeDisabled();
    expect(screen.getByText(/select or create a thread/i)).toBeInTheDocument();

    resolveNewProjectThreads({
      threads: [secondThread],
      nextCursor: null,
      backwardsCursor: null,
      rawPayload: {},
    });
    expect(await screen.findByRole("button", { name: /second thread/i })).toBeInTheDocument();
  });

  it("selects the first available thread when switching projects", async () => {
    const otherProject = {
      ...project,
      id: "project-2",
      name: "Scratch",
      cwd: "/tmp/scratch",
    };
    mockGateway(
      baseRoutes({
        "GET /v1/projects": { projects: [project, otherProject] },
        "GET /v1/threads": (request: Request) => {
          const url = new URL(request.url);
          if (url.searchParams.get("projectId") === "project-2") {
            return {
              threads: [{ ...secondThread, projectId: "project-2" }],
              nextCursor: null,
              backwardsCursor: null,
              rawPayload: {},
            };
          }
          return { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
        "GET /v1/events": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("threadId") === "thread-2"
            ? {
                events: [
                  {
                    id: "event-project-2",
                    seq: 1,
                    kind: "codex",
                    codexMethod: "item/agentMessage/delta",
                    projectId: "project-2",
                    threadId: "thread-2",
                    turnId: "turn-2",
                    itemId: "item-2",
                    payload: { delta: "Second project replay" },
                    receivedAt: "2026-04-30T00:00:01Z",
                  },
                ],
              }
            : baseRoutes()["GET /v1/events"];
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /scratch \/tmp\/scratch/i }));

    expect(await screen.findByRole("button", { name: /second thread/i })).toBeInTheDocument();
    expect(await screen.findByText(/second project replay/i)).toBeInTheDocument();
  });

  it("clears the old active thread while loading a newly selected project", async () => {
    let resolveSecondThreads: (value: unknown) => void = () => undefined;
    const secondThreads = new Promise((resolve) => {
      resolveSecondThreads = resolve;
    });
    const otherProject = {
      ...project,
      id: "project-2",
      name: "Scratch",
      cwd: "/tmp/scratch",
    };
    mockGateway(
      baseRoutes({
        "GET /v1/projects": { projects: [project, otherProject] },
        "GET /v1/threads": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("projectId") === "project-2"
            ? secondThreads
            : { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /scratch \/tmp\/scratch/i }));

    expect(screen.getByLabelText(/message composer/i)).toBeDisabled();
    expect(screen.getByText(/select or create a thread/i)).toBeInTheDocument();

    resolveSecondThreads({
      threads: [secondThread],
      nextCursor: null,
      backwardsCursor: null,
      rawPayload: {},
    });
    expect(await screen.findByRole("button", { name: /second thread/i })).toBeInTheDocument();
  });

  it("replays timeline events and uses one composer for idle send, active stop, and queued steering", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "POST /v1/threads/thread-1/turns": { payload: {} },
        "POST /v1/threads/thread-1/turns/turn-1/steer": { payload: {} },
        "POST /v1/threads/thread-1/turns/turn-1/interrupt": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/hello from codex/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBeEnabled();
    expect(screen.queryByLabelText(/steer active turn/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
    const stopButtons = screen.getAllByRole("button", { name: /stop turn/i });
    expect(stopButtons).toHaveLength(1);
    expect(stopButtons[0]).toBeEnabled();
    expect(stopButtons[0].querySelector("svg rect, svg path")).toBeInTheDocument();

    await userEvent.click(stopButtons[0]);
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/interrupt")).toHaveLength(1);
    });
  });

  it("starts idle turns with the main composer action", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/turns": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const sendButton = screen.getByRole("button", { name: /send message/i });
    expect(sendButton).toBeDisabled();
    expect(sendButton).toHaveClass("kodex-composer-action");
    expect(sendButton).toHaveAttribute("data-action-state", "idle");
    expect(container.querySelector(".kodex-composer-action svg")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /open attachment menu/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /open attachment menu/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /add attachment/i }));
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: /add attachment/i })).not.toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText(/message composer/i), "Ship it");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
    });
  });

  it("optimistically renders text sends before the turn request resolves", async () => {
    let resolveTurn: (value: unknown) => void = () => undefined;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/turns": () =>
          new Promise((resolve) => {
            resolveTurn = resolve;
          }),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Ship it");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText("Ship it")).toBeInTheDocument();
    expect(screen.getByText("Sending")).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);

    act(() => resolveTurn({ payload: {} }));
    await waitFor(() => {
      expect(screen.queryByText("Sending")).not.toBeInTheDocument();
    });
  });

  it("removes failed optimistic text sends before retrying from the restored composer", async () => {
    let turnAttempts = 0;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/turns": () => {
          turnAttempts += 1;
          if (turnAttempts === 1) {
            throw new Error("start turn failed");
          }
          return { payload: {} };
        },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Retry text");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
    });
    expect(await screen.findByText(/gateway request failed|start turn failed/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Retry text");
    expect(within(timelineElement(container)).queryByText("Retry text")).not.toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Failed")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(2);
      expect(screen.queryByText("Sending")).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
    expect(within(timelineElement(container)).getAllByText("Retry text")).toHaveLength(1);
    expect(within(timelineElement(container)).queryByText("Failed")).not.toBeInTheDocument();
  });

  it("keeps composer editing disabled during a pending text send and restores retry text on failure", async () => {
    let rejectTurn: (reason?: unknown) => void = () => undefined;
    mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/turns": () =>
          new Promise((_resolve, reject) => {
            rejectTurn = reject;
          }),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "Retry text");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText("Retry text")).toBeInTheDocument();
    expect(composer).toBeDisabled();
    await userEvent.type(composer, "New draft");
    expect(composer).toHaveValue("");

    await act(async () => {
      rejectTurn(new Error("start turn failed"));
    });

    expect(await screen.findByText(/gateway request failed|start turn failed/i)).toBeInTheDocument();
    expect(composer).toBeEnabled();
    expect(composer).toHaveValue("Retry text");
  });

  it("does not restore failed text send retry state after switching threads", async () => {
    let rejectTurn: (reason?: unknown) => void = () => undefined;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/turns": () =>
          new Promise((_resolve, reject) => {
            rejectTurn = reject;
          }),
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Retry in first thread");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    expect(await screen.findByText("Retry in first thread")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();

    await act(async () => {
      rejectTurn(new Error("start turn failed"));
    });

    expect(await screen.findByText(/gateway request failed|start turn failed/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
    expect(within(timelineElement(container)).queryByText("Retry in first thread")).not.toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/turns")).toHaveLength(0);
  });

  it("attaches image files, uploads them on send, and posts local image inputs", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/uploads/images": { images: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" }] },
        "POST /v1/threads/thread-1/turns": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    const file = new File(["fake"], "diagram.png", { type: "image/png" });
    await userEvent.upload(input!, file);

    expect(screen.getByRole("button", { name: /remove diagram.png/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Inspect this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/turns")[0])).resolves.toEqual({
      input: [
        { type: "text", text: "Inspect this" },
        { type: "localImage", path: "/tmp/diagram.png" },
      ],
    });
  });

  it("optimistically renders image sends while upload is pending", async () => {
    let resolveUpload: (value: unknown) => void = () => undefined;
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pending-diagram");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/uploads/images": () =>
          new Promise((resolve) => {
            resolveUpload = resolve;
          }),
        "POST /v1/threads/thread-1/turns": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await userEvent.upload(input!, new File(["fake"], "diagram.png", { type: "image/png" }));
    expect(createObjectUrl).toHaveBeenCalled();
    expect(createObjectUrl).toHaveBeenCalledTimes(1);

    await userEvent.type(screen.getByLabelText(/message composer/i), "Inspect this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await within(timelineElement(container)).findByText("Inspect this")).toBeInTheDocument();
    expect(screen.getByText("Uploading")).toBeInTheDocument();
    expect(input).toBeDisabled();
    fireEvent.change(input!, {
      target: { files: [new File(["fake"], "second-diagram.png", { type: "image/png" })] },
    });
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /remove second-diagram.png/i })).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-user-image-grid img")).toHaveAttribute("src", "blob:pending-diagram");
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(0);

    act(() =>
      resolveUpload({
        images: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" }],
      }),
    );
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
      expect(screen.queryByText("Uploading")).not.toBeInTheDocument();
    });
  });

  it("optimistically renders draft thread image sends before upload resolves", async () => {
    let resolveUpload: (value: unknown) => void = () => undefined;
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:draft-diagram");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads": { thread: { ...thread, id: "thread-2", name: "New thread", preview: null }, rawPayload: {} },
        "POST /v1/uploads/images": () =>
          new Promise((resolve) => {
            resolveUpload = resolve;
          }),
        "POST /v1/threads/thread-2/turns": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    expect(screen.getByRole("heading", { name: /new thread/i })).toBeInTheDocument();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await userEvent.upload(input!, new File(["fake"], "diagram.png", { type: "image/png" }));
    expect(createObjectUrl).toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/message composer/i), "Inspect this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await within(timelineElement(container)).findByText("Inspect this")).toBeInTheDocument();
    expect(screen.getByText("Uploading")).toBeInTheDocument();
    expect(container.querySelector(".kodex-user-image-grid img")).toHaveAttribute("src", "blob:draft-diagram");
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/turns")).toHaveLength(0);
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:draft-diagram");

    act(() =>
      resolveUpload({
        images: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" }],
      }),
    );
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/turns")).toHaveLength(1);
      expect(screen.queryByText("Uploading")).not.toBeInTheDocument();
    });
  });

  it("keeps failed draft thread image uploads visible and retryable", async () => {
    let rejectUpload: (reason?: unknown) => void = () => undefined;
    let uploadAttempts = 0;
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:draft-retry-diagram");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads": { thread: { ...thread, id: "thread-2", name: "New thread", preview: null }, rawPayload: {} },
        "POST /v1/uploads/images": () => {
          uploadAttempts += 1;
          if (uploadAttempts === 1) {
            return new Promise((_resolve, reject) => {
              rejectUpload = reject;
            });
          }
          return {
            images: [
              { id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" },
            ],
          };
        },
        "POST /v1/threads/thread-2/turns": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await userEvent.upload(input!, new File(["fake"], "diagram.png", { type: "image/png" }));
    expect(createObjectUrl).toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/message composer/i), "Inspect this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await within(timelineElement(container)).findByText("Inspect this")).toBeInTheDocument();
    expect(screen.getByText("Uploading")).toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/turns")).toHaveLength(0);
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:draft-retry-diagram");

    await act(async () => {
      rejectUpload(new Error("Upload unavailable"));
    });

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove diagram.png/i })).toBeInTheDocument();
    expect(screen.getByText("Upload unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Inspect this");
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:draft-retry-diagram");

    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(2);
      expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/turns")).toHaveLength(1);
    });
    expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    expect(within(timelineElement(container)).getAllByText("Inspect this")).toHaveLength(1);
  });

  it("keeps failed uploads visible and retryable", async () => {
    let uploadAttempts = 0;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/uploads/images": () => {
          uploadAttempts += 1;
          if (uploadAttempts === 1) {
            throw new Error("Upload unavailable");
          }
          return {
            images: [
              { id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" },
            ],
          };
        },
        "POST /v1/threads/thread-1/turns": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    const file = new File(["fake"], "diagram.png", { type: "image/png" });
    await userEvent.upload(input!, file);
    await userEvent.type(screen.getByLabelText(/message composer/i), "Inspect this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove diagram.png/i })).toBeInTheDocument();
    expect(screen.getByText("Upload unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Inspect this");
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(2);
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
    });
    expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    expect(within(timelineElement(container)).getAllByText("Inspect this")).toHaveLength(1);
  });

  it("does not restore failed image upload retry state after switching threads", async () => {
    let rejectUpload: (reason?: unknown) => void = () => undefined;
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:switched-diagram");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/events": { events: [] },
        "POST /v1/uploads/images": () =>
          new Promise((_resolve, reject) => {
            rejectUpload = reject;
          }),
        "POST /v1/threads/thread-1/turns": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await userEvent.upload(input!, new File(["fake"], "diagram.png", { type: "image/png" }));
    expect(createObjectUrl).toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Inspect this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    expect(await screen.findByText("Inspect this")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();

    await act(async () => {
      rejectUpload(new Error("Upload unavailable"));
    });

    expect(await screen.findByText("Upload unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
    expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/turns")).toHaveLength(0);
  });

  it("removes failed optimistic image sends after upload before retrying the turn start", async () => {
    let turnAttempts = 0;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/uploads/images": {
          images: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" }],
        },
        "POST /v1/threads/thread-1/turns": () => {
          turnAttempts += 1;
          if (turnAttempts === 1) {
            throw new Error("start turn failed");
          }
          return { payload: {} };
        },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await userEvent.upload(input!, new File(["fake"], "diagram.png", { type: "image/png" }));
    await userEvent.type(screen.getByLabelText(/message composer/i), "Inspect this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
    });
    expect(await screen.findByText(/gateway request failed|start turn failed/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Inspect this");
    expect(screen.getByRole("button", { name: /remove diagram.png/i })).toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Failed")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/turns")[1])).resolves.toEqual({
      input: [
        { type: "text", text: "Inspect this" },
        { type: "localImage", path: "/tmp/diagram.png" },
      ],
    });
    expect(within(timelineElement(container)).getAllByText("Inspect this")).toHaveLength(1);
    expect(within(timelineElement(container)).queryByText("Failed")).not.toBeInTheDocument();
  });

  it("keeps sent image previews renderable after pending attachments are cleared", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:diagram-preview");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/uploads/images": {
          images: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" }],
        },
        "POST /v1/threads/thread-1/turns": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await userEvent.upload(input!, new File(["fake"], "diagram.png", { type: "image/png" }));
    expect(createObjectUrl).toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText(/message composer/i), "Inspect this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    });
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:diagram-preview");

    let selectedThreadStream: FakeEventSource | undefined;
    await waitFor(() => {
      selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
      expect(selectedThreadStream).toBeDefined();
    });
    act(() => {
      selectedThreadStream?.emit({
        id: "event-user-image",
        seq: 2,
        kind: "codex",
        codexMethod: "item/completed",
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "user-image-1",
        payload: {
          item: {
            id: "user-image-1",
            type: "userMessage",
            content: [
              { type: "localImage", path: "/tmp/diagram.png" },
              { type: "text", text: "Inspect this" },
            ],
          },
        },
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    expect(await screen.findByText("Inspect this")).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector(".kodex-user-image-grid img")).toHaveAttribute("src", "blob:diagram-preview");
    });
  });

  it("shows a composer drop hint and attaches dropped image files", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const composerShell = screen.getByLabelText(/message composer/i).closest(".kodex-composer-shell");
    expect(composerShell).not.toBeNull();
    const file = new File(["fake"], "dropped.png", { type: "image/png" });
    const dataTransfer = {
      files: [file],
      items: [{ kind: "file", type: "image/png" }],
    };

    fireEvent.dragOver(composerShell!, { dataTransfer });
    expect(screen.getByText(/drop images to attach/i)).toBeInTheDocument();
    fireEvent.drop(composerShell!, { dataTransfer });

    expect(screen.getByRole("button", { name: /remove dropped.png/i })).toBeInTheDocument();
    expect(screen.queryByText(/drop images to attach/i)).not.toBeInTheDocument();
  });

  it("queues active-turn composer text, steers selected rows, and removes only successful rows", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/events": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("threadId") === "thread-2" ? { events: [] } : baseRoutes()["GET /v1/events"];
        },
        "POST /v1/threads/thread-1/turns/turn-1/steer": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/hello from codex/i)).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    expect(screen.getByRole("button", { name: /stop turn/i })).toBeInTheDocument();
    await userEvent.type(composer, "Add tests");
    expect(screen.queryByRole("button", { name: /stop turn/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    await userEvent.type(composer, "Keep scope tight{Enter}");

    const queuedCard = screen.getByRole("region", { name: /queued steer messages/i });
    const rows = within(queuedCard).getAllByRole("group");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Add tests");
    expect(rows[1]).toHaveTextContent("Keep scope tight");
    expect(rows[0].getAttribute("data-steer-row-id")).not.toEqual(rows[1].getAttribute("data-steer-row-id"));
    expect(composer).toHaveValue("");
    expect(screen.getAllByRole("button", { name: /abort queued message/i })).toHaveLength(2);

    await userEvent.click(within(rows[0]).getByRole("button", { name: /steer/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/steer")).toHaveLength(1);
      expect(within(screen.getByRole("region", { name: /queued steer messages/i })).queryByText("Add tests")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Keep scope tight")).toBeInTheDocument();

    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/steer")[0])).resolves.toEqual({
      input: [{ type: "text", text: "Add tests" }],
    });

    await userEvent.click(
      within(screen.getByRole("region", { name: /queued steer messages/i })).getByRole("button", {
        name: /abort queued message/i,
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: /queued steer messages/i })).not.toBeInTheDocument();
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/steer")).toHaveLength(1);

    await userEvent.type(composer, "Switch clear{Enter}");
    expect(screen.getByText("Switch clear")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: /queued steer messages/i })).not.toBeInTheDocument();
    });
  });

  it("keeps failed queued steer rows retryable and reports the existing error", async () => {
    let failNextSteer = true;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "POST /v1/threads/thread-1/turns/turn-1/steer": () => {
          if (failNextSteer) {
            failNextSteer = false;
            throw new Error("steer failed");
          }
          return { payload: {} };
        },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/hello from codex/i)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Retry this{Enter}");
    const queuedCard = screen.getByRole("region", { name: /queued steer messages/i });
    const row = within(queuedCard).getByRole("group");
    const rowId = row.getAttribute("data-steer-row-id");

    await userEvent.click(within(row).getByRole("button", { name: /steer/i }));
    expect(await screen.findByText(/gateway request failed|steer failed/i)).toBeInTheDocument();
    expect(screen.getByText("Retry this")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: /queued steer messages/i })).getByRole("group")).toHaveAttribute(
      "data-steer-row-id",
      rowId,
    );

    await userEvent.click(within(screen.getByRole("region", { name: /queued steer messages/i })).getByRole("button", { name: /steer/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/steer")).toHaveLength(2);
      expect(screen.queryByRole("region", { name: /queued steer messages/i })).not.toBeInTheDocument();
    });
  });

  it("submits on Enter and keeps Shift+Enter as a newline in the main composer", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/turns": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "Line one");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await userEvent.type(composer, "Line two");

    expect(composer).toHaveValue("Line one\nLine two");
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(0);

    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
    });
  });

  it("groups command and search activity into nested timeline collapsibles", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/events": {
          events: [
            {
              id: "event-command",
              seq: 1,
              kind: "codex.notification",
              codexMethod: "item/completed",
              projectId: project.id,
              threadId: thread.id,
              turnId: "turn-1",
              itemId: "cmd-1",
              payload: {
                item: {
                  id: "cmd-1",
                  type: "commandExecution",
                  command: "pwd",
                  cwd: "/home/example/kodex",
                  output: "/home/example/kodex\n",
                },
              },
              receivedAt: "2026-04-30T00:00:00Z",
            },
            {
              id: "event-search",
              seq: 2,
              kind: "codex.notification",
              codexMethod: "item/completed",
              projectId: project.id,
              threadId: thread.id,
              turnId: "turn-1",
              itemId: "web-1",
              payload: {
                item: {
                  id: "web-1",
                  type: "webSearch",
                  action: { type: "search", query: "Codex renderer nested collapsibles" },
                },
              },
              receivedAt: "2026-04-30T00:00:01Z",
            },
          ],
        },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText("Searched web, ran 1 command")).toBeInTheDocument();
    expect(within(timeline).getByText("Ran pwd")).toBeInTheDocument();
    expect(within(timeline).getByText("$ pwd")).toBeInTheDocument();
    expect(within(timeline).getByText("Searched web")).toBeInTheDocument();
  });

  it("posts schema-shaped command, file, permission, MCP, and tool-user-input approval responses", async () => {
    const approval = {
      id: "approval-1",
      requestId: "request-1",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo test", cwd: "/home/example/kodex", reason: "Verify frontend" },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    const fileApproval = {
      ...approval,
      id: "approval-2",
      method: "item/fileChange/requestApproval",
      payload: { path: "src/App.tsx", reason: "Apply generated patch" },
    };
    const permissionApproval = {
      ...approval,
      id: "approval-3",
      method: "item/permissions/requestApproval",
      payload: {
        reason: "Needs network access",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    };
    const mcpApproval = {
      ...approval,
      id: "approval-4",
      method: "mcpServer/elicitation/request",
      payload: { message: "Share workspace metadata?" },
    };
    const userInputApproval = {
      ...approval,
      id: "approval-5",
      method: "item/tool/requestUserInput",
      payload: {
        questions: [{ id: "choice", header: "Choice", question: "Pick one" }],
      },
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/approvals": {
          approvals: [approval, fileApproval, permissionApproval, mcpApproval, userInputApproval],
        },
        "POST /v1/approvals/approval-1/decision": { ...approval, status: "resolved", response: { decision: "accept" } },
        "POST /v1/approvals/approval-2/decision": {
          ...fileApproval,
          status: "resolved",
          response: { decision: "acceptForSession" },
        },
        "POST /v1/approvals/approval-3/decision": {
          ...permissionApproval,
          status: "resolved",
          response: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" },
        },
        "POST /v1/approvals/approval-4/decision": {
          ...mcpApproval,
          status: "resolved",
          response: { action: "decline" },
        },
        "POST /v1/approvals/approval-5/decision": {
          ...userInputApproval,
          status: "resolved",
          response: { answers: { choice: { answers: [] } } },
        },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(within(timeline).getByText(/would you like to run the following command/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/\$ cargo test/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/src\/app\.tsx/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/needs network access/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/share workspace metadata/i)).toBeInTheDocument();
    const permissionCard = within(timeline)
      .getByText(/needs network access/i)
      .closest(".kodex-approval-card") as HTMLElement;
    expect(within(permissionCard).getByRole("button", { name: /no, continue without permissions/i })).toBeInTheDocument();
    await userEvent.click(within(timeline).getAllByRole("button", { name: /yes, proceed/i })[0]);
    await userEvent.click(within(timeline).getByRole("button", { name: /yes, and don't ask again for these files/i }));
    await userEvent.click(within(timeline).getByRole("button", { name: /yes, grant these permissions for this turn/i }));
    await userEvent.click(within(timeline).getByRole("button", { name: /no, but continue without it/i }));
    await userEvent.click(within(timeline).getByRole("button", { name: /submit answers/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/approvals/approval-1/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-2/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-3/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-4/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-5/decision")).toHaveLength(1);
      expect(within(timeline).queryByText(/cargo test/i)).not.toBeInTheDocument();
    });

    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-1/decision")[0])).resolves.toEqual({
      decision: { decision: "accept" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-2/decision")[0])).resolves.toEqual({
      decision: { decision: "acceptForSession" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-3/decision")[0])).resolves.toEqual({
      decision: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-4/decision")[0])).resolves.toEqual({
      decision: { action: "decline" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-5/decision")[0])).resolves.toEqual({
      decision: { answers: { choice: { answers: [] } } },
    });
  });

  it("posts strict auto review for turn-scoped permission approval", async () => {
    const approval = {
      id: "approval-strict-permissions",
      requestId: "request-strict-permissions",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/permissions/requestApproval",
      status: "pending",
      payload: {
        reason: "Needs network access",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [approval] },
        "POST /v1/approvals/approval-strict-permissions/decision": {
          ...approval,
          status: "resolved",
          response: {
            permissions: { network: { enabled: true }, fileSystem: null },
            scope: "turn",
            strictAutoReview: true,
          },
        },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    await userEvent.click(
      within(timeline).getByRole("button", { name: /yes, grant for this turn with strict auto review/i }),
    );

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/approvals/approval-strict-permissions/decision")).toHaveLength(1);
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-strict-permissions/decision")[0])).resolves.toEqual({
      decision: {
        permissions: { network: { enabled: true }, fileSystem: null },
        scope: "turn",
        strictAutoReview: true,
      },
    });
  });

  it("renders command approvals with a human title and command block", async () => {
    const approval = {
      id: "approval-command-display",
      requestId: "request-command-display",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: {
        command: "npm run build -- --mode production && npm run test:e2e",
        cwd: "/home/example/kodex/apps/web",
        reason: "Verify production UI",
      },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [approval] },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/would you like to run the following command/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/reason: verify production ui/i)).toBeInTheDocument();
    const command = within(timeline).getByText(/\$ npm run build -- --mode production/i);
    expect(command.closest("code")).toHaveClass("kodex-approval-command");
  });

  it("keeps long approval commands and action labels inside the card", async () => {
    const longPrefix = `allow ${"very-long-option-without-natural-breaks-".repeat(8)}suffix`;
    const longCommand = `/usr/bin/env ${"--long-option-without-natural-breaks=".repeat(8)}value`;
    const approval = {
      id: "approval-long-display",
      requestId: "request-long-display",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: {
        command: longCommand,
        commandActions: [{ type: "unknown", command: longCommand }],
        cwd: "/home/example/kodex",
        proposedExecpolicyAmendment: [longPrefix],
        reason: "Exercise long approval text",
      },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [approval] },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    const command = await within(timeline).findByText(`$ ${longCommand}`);
    const action = within(timeline).getByRole("button", {
      name: /yes, and don't ask again for commands that start with/i,
    });

    expect(command).toHaveClass("kodex-approval-command");
    expect(action).toHaveClass("kodex-approval-action");
    expect(appCss).toMatch(/\.kodex-approval-command\s*\{[^}]*min-width:\s*0;/s);
    expect(appCss).toMatch(/\.kodex-approval-command\s*\{[^}]*max-width:\s*100%;/s);
    expect(appCss).toMatch(/\.kodex-approval-command\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(appCss).toMatch(/\.kodex-approval-action\s*\{[^}]*max-width:\s*100%;/s);
    expect(appCss).toMatch(/\.kodex-approval-action\s*\{[^}]*white-space:\s*normal;/s);
  });

  it("does not resurrect a locally resolved approval from a stale created event", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const approval = {
      id: "approval-local-resolution",
      requestId: "request-local-resolution",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo test", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [approval] },
        "POST /v1/approvals/approval-local-resolution/decision": {
          ...approval,
          status: "resolved",
          response: { decision: "accept" },
          resolvedAt: "2026-04-30T00:00:01Z",
        },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/cargo test/i)).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    await userEvent.click(within(timeline).getByRole("button", { name: /yes, proceed/i }));
    await waitFor(() => {
      expect(within(timeline).queryByText(/cargo test/i)).not.toBeInTheDocument();
    });

    act(() => {
      globalApprovalStream?.emit({
        id: "event-stale-local-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: approval,
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(within(timeline).queryByText(/cargo test/i)).not.toBeInTheDocument();
  });

  it("renders command approval actions and posts amendment approval responses", async () => {
    const execPolicyApproval = {
      id: "approval-policy",
      requestId: "request-policy",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: {
        command: "rg TODO apps/web",
        commandActions: [{ type: "search", command: "rg", path: "apps/web", query: "TODO" }],
        cwd: "/home/example/kodex",
        proposedExecpolicyAmendment: ["allow rg TODO apps/web"],
        reason: "Search source",
      },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    const networkPolicyApproval = {
      ...execPolicyApproval,
      id: "approval-network",
      requestId: "request-network",
      payload: {
        command: "curl https://api.example.com",
        commandActions: [{ type: "unknown", command: "curl https://api.example.com" }],
        cwd: "/home/example/kodex",
        networkApprovalContext: { host: "api.example.com" },
        proposedNetworkPolicyAmendments: [{ action: "allow", host: "api.example.com" }],
        reason: "Fetch API data",
      },
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [execPolicyApproval, networkPolicyApproval] },
        "POST /v1/approvals/approval-policy/decision": {
          ...execPolicyApproval,
          status: "resolved",
          response: {
            decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["allow rg TODO apps/web"] } },
          },
        },
        "POST /v1/approvals/approval-network/decision": {
          ...networkPolicyApproval,
          status: "resolved",
          response: {
            decision: {
              applyNetworkPolicyAmendment: { network_policy_amendment: { action: "allow", host: "api.example.com" } },
            },
          },
        },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/search todo in apps\/web/i)).toBeInTheDocument();
    expect(within(timeline).getAllByText(/curl https:\/\/api\.example\.com/i).length).toBeGreaterThan(0);

    await userEvent.click(
      within(timeline).getByRole("button", {
        name: /yes, and don't ask again for commands that start with `allow rg todo apps\/web`/i,
      }),
    );
    await userEvent.click(within(timeline).getByRole("button", { name: /yes, and allow this host in the future/i }));

    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-policy/decision")[0])).resolves.toEqual({
      decision: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["allow rg TODO apps/web"] } } },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-network/decision")[0])).resolves.toEqual({
      decision: {
        decision: {
          applyNetworkPolicyAmendment: { network_policy_amendment: { action: "allow", host: "api.example.com" } },
        },
      },
    });
  });

  it("applies approval created and resolved events from the stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(baseRoutes());
    const streamedApproval = {
      id: "approval-streamed",
      requestId: "request-streamed",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "npm test", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    let selectedThreadStream: FakeEventSource | undefined;
    await waitFor(() => {
      selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
      expect(selectedThreadStream).toBeDefined();
    });
    act(() => {
      selectedThreadStream?.emit({
        id: "event-approval-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: streamedApproval,
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    expect(await within(timeline).findByText(/npm test/i)).toBeInTheDocument();

    act(() => {
      selectedThreadStream?.emit({
        id: "event-approval-resolved",
        seq: 3,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: { ...streamedApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    await waitFor(() => {
      expect(within(timeline).queryByText(/npm test/i)).not.toBeInTheDocument();
    });
    expect(gateway.callsFor("GET", "/v1/events")).toHaveLength(1);
  });

  it("keeps non-selected thread approval badges in sync", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );
    const streamedApproval = {
      id: "approval-other-thread",
      requestId: "request-other-thread",
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo fmt", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-other-approval-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: streamedApproval,
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });
    expect(await within(secondThreadButton).findByText(/needs approval/i)).toBeInTheDocument();

    await userEvent.click(secondThreadButton);
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/cargo fmt/i)).toBeInTheDocument();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-other-approval-resolved",
        seq: 3,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: { ...streamedApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });
    await waitFor(() => {
      expect(within(timeline).queryByText(/cargo fmt/i)).not.toBeInTheDocument();
      expect(within(secondThreadButton).queryByText(/needs approval/i)).not.toBeInTheDocument();
    });
  });

  it("does not drop streamed approvals when the initial pending approval request resolves later", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveApprovals: (value: unknown) => void = () => undefined;
    const delayedApprovals = new Promise((resolve) => {
      resolveApprovals = resolve;
    });
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/approvals": () => delayedApprovals,
      }),
    );
    const streamedApproval = {
      id: "approval-before-load",
      requestId: "request-before-load",
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "npm run build", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-before-load-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: streamedApproval,
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });
    expect(await within(secondThreadButton).findByText(/needs approval/i)).toBeInTheDocument();

    await userEvent.click(secondThreadButton);
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/npm run build/i)).toBeInTheDocument();

    await act(async () => {
      resolveApprovals({ approvals: [] });
      await Promise.resolve();
    });
    expect(within(timeline).getByText(/npm run build/i)).toBeInTheDocument();
  });

  it("does not resurrect a resolved approval from a late stale pending approval response", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveApprovals: (value: unknown) => void = () => undefined;
    const delayedApprovals = new Promise((resolve) => {
      resolveApprovals = resolve;
    });
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/approvals": () => delayedApprovals,
      }),
    );
    const staleApproval = {
      id: "approval-resolved-before-load",
      requestId: "request-resolved-before-load",
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "npm test", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-before-load-resolved",
        seq: 2,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: { ...staleApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    await act(async () => {
      resolveApprovals({ approvals: [staleApproval] });
      await Promise.resolve();
    });
    expect(within(secondThreadButton).queryByText(/needs approval/i)).not.toBeInTheDocument();
  });

  it("does not resurrect a resolved approval from a later stale created event", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(baseRoutes());
    const staleApproval = {
      id: "approval-resolved-before-created-replay",
      requestId: "request-resolved-before-created-replay",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo clippy", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const timeline = await screen.findByRole("main", { name: /thread/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-resolved-before-created-replay",
        seq: 3,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: { ...staleApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:03Z",
      });
      globalApprovalStream?.emit({
        id: "event-created-after-resolved-replay",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: staleApproval,
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(within(timeline).queryByText(/cargo clippy/i)).not.toBeInTheDocument();
  });

  it("ignores stale event replay and streams after switching threads", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveFirstEvents: (value: unknown) => void = () => undefined;
    let resolveSecondEvents: (value: unknown) => void = () => undefined;
    const firstEvents = new Promise((resolve) => {
      resolveFirstEvents = resolve;
    });
    const secondEvents = new Promise((resolve) => {
      resolveSecondEvents = resolve;
    });
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/events": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("threadId") === "thread-1" ? firstEvents : secondEvents;
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    resolveSecondEvents({
      events: [
        {
          id: "event-second",
          seq: 1,
          kind: "codex",
          codexMethod: "item/agentMessage/delta",
          projectId: project.id,
          threadId: "thread-2",
          turnId: "turn-2",
          itemId: "item-2",
          payload: { delta: "Second thread replay" },
          receivedAt: "2026-04-30T00:00:01Z",
        },
      ],
    });

    expect(await screen.findByText(/second thread replay/i)).toBeInTheDocument();
    resolveFirstEvents({
      events: [
        {
          id: "event-first",
          seq: 1,
          kind: "codex",
          codexMethod: "item/agentMessage/delta",
          projectId: project.id,
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          payload: { delta: "Stale first thread replay" },
          receivedAt: "2026-04-30T00:00:02Z",
        },
      ],
    });

    await waitFor(() => {
      expect(screen.queryByText(/stale first thread replay/i)).not.toBeInTheDocument();
    });
    const threadStreams = FakeEventSource.instances.filter((instance) => instance.url.includes("threadId="));
    expect(threadStreams).toHaveLength(1);
    expect(threadStreams[0].url).toContain("threadId=thread-2");
  });

  it("ignores late events from a closed previous thread stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/events": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("threadId") === "thread-2"
            ? {
                events: [
                  {
                    id: "event-second",
                    seq: 1,
                    kind: "codex",
                    codexMethod: "item/agentMessage/delta",
                    projectId: project.id,
                    threadId: "thread-2",
                    turnId: "turn-2",
                    itemId: "item-2",
                    payload: { delta: "Second thread replay" },
                    receivedAt: "2026-04-30T00:00:01Z",
                  },
                ],
              }
            : {
                events: [
                  {
                    id: "event-first",
                    seq: 1,
                    kind: "codex",
                    codexMethod: "item/agentMessage/delta",
                    projectId: project.id,
                    threadId: "thread-1",
                    turnId: "turn-1",
                    itemId: "item-1",
                    payload: { delta: "First thread replay" },
                    receivedAt: "2026-04-30T00:00:00Z",
                  },
                ],
              };
        },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/first thread replay/i)).toBeInTheDocument();
    const firstThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    expect(firstThreadStream).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(await screen.findByText(/second thread replay/i)).toBeInTheDocument();

    act(() => {
      firstThreadStream?.emit({
        id: "event-stale-closed-stream",
        seq: 2,
        kind: "codex",
        codexMethod: "item/agentMessage/delta",
        projectId: project.id,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        payload: { delta: "Stale closed stream delta" },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    await waitFor(() => {
      expect(screen.queryByText(/stale closed stream delta/i)).not.toBeInTheDocument();
    });
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

  it("renders authenticated account state and logs out", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/account": {
          requiresOpenaiAuth: false,
          account: {
            accountType: "chatgpt",
            email: "dev@example.com",
            planType: "pro",
            rawPayload: {},
          },
          rawPayload: {},
        },
        "POST /v1/account/logout": { payload: {} },
      }),
    );

    render(<App />);

    const avatar = await screen.findByRole("img", { name: /dev@example\.com/i });
    expect(avatar).toHaveTextContent("D");
    await userEvent.click(screen.getByRole("button", { name: /account settings/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /logout/i }));
    expect(gateway.callsFor("POST", "/v1/account/logout")).toHaveLength(1);
    expect(await screen.findByRole("button", { name: /connect chatgpt/i })).toBeInTheDocument();
  });
});
