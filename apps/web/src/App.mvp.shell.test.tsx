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

describe("MVP shell flows", () => {
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
    const main = screen.getByRole("main", { name: /thread/i });
    expect(within(main).getByText(/good (morning|afternoon|evening)|burning the midnight oil\?/i)).toBeInTheDocument();
    const mainStack = main.querySelector(".kodex-main-stack");
    expect(mainStack).toHaveAttribute("data-draft-thread", "true");
    expect(main.querySelector(".kodex-timeline-scroll")).not.toBeInTheDocument();
    expect(within(main).queryByText("No events")).not.toBeInTheDocument();
    expect(appCss).toMatch(
      /\.kodex-main-stack\[data-draft-thread="true"\]\s+\.kodex-composer-shell\s*\{[^}]*margin-top:\s*auto;/s,
    );
    expect(appCss).toMatch(
      /\.kodex-main-stack\[data-draft-thread="true"\]\s+\.kodex-composer-shell\s*\{[^}]*margin-bottom:\s*auto;/s,
    );
    expect(appCss).toMatch(/\.kodex-composer-hero-stage\[data-transitioning="true"\]\s*\{[^}]*opacity:\s*0;/s);

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
    const kodexProjectButton = within(kodexGroup).getByRole("button", { name: /kodex \/home\/example\/kodex/i });
    expect(kodexProjectButton).toHaveAttribute("aria-expanded", "true");
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();

    const scratchGroup = await screen.findByRole("group", { name: /scratch/i });
    const scratchProjectButton = within(scratchGroup).getByRole("button", { name: /scratch \/tmp\/scratch/i });
    expect(scratchProjectButton).toHaveAttribute("aria-expanded", "true");
    expect(within(scratchGroup).getByRole("button", { name: /second thread/i })).toBeInTheDocument();

    await userEvent.click(kodexProjectButton);

    expect(kodexProjectButton).toHaveAttribute("aria-expanded", "false");
    expect(within(kodexGroup).queryByRole("button", { name: /implement frontend/i })).not.toBeInTheDocument();

    await userEvent.click(kodexProjectButton);

    expect(kodexProjectButton).toHaveAttribute("aria-expanded", "true");
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
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

  it("archives a thread from the thread selector hover action", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-2/archive": { payload: {} },
      }),
    );

    render(<App />);

    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    await userEvent.hover(secondThreadButton);
    await userEvent.click(screen.getByRole("button", { name: /archive second thread/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/archive")).toHaveLength(1);
    });
    expect(screen.queryByRole("button", { name: /second thread/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
  });

  it("shows in-progress threads in the selector action slot until archive is available", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, { ...activeThread, id: "thread-2", name: "Running thread" }],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    const runningThreadButton = await screen.findByRole("button", { name: /running thread/i });
    const runningThreadRow = runningThreadButton.closest(".kodex-thread-list-button");
    expect(runningThreadRow).toBeInTheDocument();
    expect(within(runningThreadRow as HTMLElement).getByLabelText(/thread in progress/i)).toHaveClass(
      "kodex-thread-progress-indicator",
    );
    expect(within(runningThreadRow as HTMLElement).queryByRole("button", { name: /archive running thread/i })).not.toBeInTheDocument();

    await userEvent.hover(runningThreadButton);

    expect(within(runningThreadRow as HTMLElement).getByRole("button", { name: /archive running thread/i })).toBeInTheDocument();
    expect(within(runningThreadRow as HTMLElement).queryByLabelText(/thread in progress/i)).not.toBeInTheDocument();
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

  it("returns narrow viewport navigation to chat after selecting or creating a thread", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      }),
    );

    render(<App />);

    const panelSwitcher = await screen.findByRole("tablist", { name: /mobile panels/i });
    const threadsTab = within(panelSwitcher).getByRole("tab", { name: /threads/i });
    const chatTab = within(panelSwitcher).getByRole("tab", { name: /chat/i });

    await userEvent.click(threadsTab);
    expect(threadsTab).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(chatTab).toHaveAttribute("aria-selected", "true");

    await userEvent.click(threadsTab);
    expect(threadsTab).toHaveAttribute("aria-selected", "true");

    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    expect(chatTab).toHaveAttribute("aria-selected", "true");
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
