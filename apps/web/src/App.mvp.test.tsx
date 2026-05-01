import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { mockGateway, requestJson } from "./test/gatewayMock";

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
    ...overrides,
  };
}

describe("MVP frontend flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("renders projects and threads, creates a project, and starts a draft thread after the first message", async () => {
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

    await userEvent.type(screen.getByLabelText(/message composer/i), "Implement the next milestone");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/turns")).toHaveLength(1);
    });
    const draftThreadButtons = await screen.findAllByRole("button", { name: /new thread/i });
    expect(draftThreadButtons).toHaveLength(2);
    const draftTitle = within(draftThreadButtons[1]).getByText("New thread");
    expect(draftTitle).toHaveAttribute("data-placeholder-title", "true");

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
    expect(within(threadView).queryByText(/verify changes/i)).not.toBeInTheDocument();
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
    await userEvent.type(composer, "Add tests{Enter}");
    await userEvent.type(composer, "Keep scope tight{Enter}");

    const queuedCard = screen.getByRole("region", { name: /queued steer messages/i });
    const rows = within(queuedCard).getAllByRole("group");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Add tests");
    expect(rows[1]).toHaveTextContent("Keep scope tight");
    expect(rows[0].getAttribute("data-steer-row-id")).not.toEqual(rows[1].getAttribute("data-steer-row-id"));
    expect(composer).toHaveValue("");

    await userEvent.click(within(rows[0]).getByRole("button", { name: /steer/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/steer")).toHaveLength(1);
      expect(screen.queryByText("Add tests")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Keep scope tight")).toBeInTheDocument();

    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/steer")[0])).resolves.toEqual({
      input: [{ type: "text", text: "Add tests" }],
    });

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
      expect(screen.queryByText("Retry this")).not.toBeInTheDocument();
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
    expect(within(timeline).getByText(/cargo test/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/src\/app\.tsx/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/needs network access/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/share workspace metadata/i)).toBeInTheDocument();
    const permissionCard = within(timeline)
      .getByText(/needs network access/i)
      .closest(".kodex-approval-card") as HTMLElement;
    expect(within(permissionCard).queryByRole("button", { name: /decline approval/i })).not.toBeInTheDocument();
    expect(within(permissionCard).queryByRole("button", { name: /cancel approval/i })).not.toBeInTheDocument();
    await userEvent.click(within(timeline).getAllByRole("button", { name: /accept approval/i })[0]);
    await userEvent.click(within(timeline).getAllByRole("button", { name: /accept for session/i })[0]);
    await userEvent.click(within(timeline).getByRole("button", { name: /grant approval/i }));
    await userEvent.click(within(timeline).getAllByRole("button", { name: /decline approval/i })[0]);
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
    expect(await within(timeline).findByText(/command approval/i)).toBeInTheDocument();
    const command = within(timeline).getByText(/npm run build -- --mode production/i);
    expect(command.closest("code")).toHaveClass("kodex-approval-command");
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

    await userEvent.click(within(timeline).getAllByRole("button", { name: /accept approval/i })[0]);
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

    await userEvent.click(within(timeline).getByRole("button", { name: /apply exec policy approval/i }));
    await userEvent.click(within(timeline).getByRole("button", { name: /apply allow policy for api\.example\.com/i }));

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

    expect(screen.queryByLabelText(/model/i)).not.toBeInTheDocument();
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
