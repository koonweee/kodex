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
  snapshotItem,
  snapshotTurn,
  thread,
  threadDetail,
  timelineElement,
} from "./test/mvpAppHarness";

function clickMenuItem(name: RegExp) {
  return clickMenuItemWithDeps(name, screen, waitFor, fireEvent);
}

function addProjectSubmitButton() {
  const buttons = screen.getAllByRole("button", { name: /add project/i });
  return buttons[buttons.length - 1];
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

describe("MVP shell flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("renders projects and threads, creates a project, and promotes a draft thread title from the first message", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/projects": async (request: Request) => {
          const body = (await requestJson(request)) as { createDirectory?: boolean; cwd: string; name?: string | null };
          if (!body.createDirectory) {
            return new Response(JSON.stringify({ message: "directory does not exist" }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            });
          }
          return {
            cwd: "/home/example/scratch",
            id: "project-2",
            name: "scratch",
            createdAt: "2026-04-30T00:00:00Z",
            updatedAt: "2026-04-30T00:00:00Z",
          };
        },
        "POST /v1/threads": { thread: { ...thread, id: "thread-2", name: "New thread", preview: "" }, rawPayload: {} },
        "GET /v1/threads/thread-2": threadDetail(
          { ...thread, id: "thread-2", name: "New thread", preview: "Implement the next milestone for the web client" },
          [],
        ),
        "POST /v1/threads/thread-2/turns": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByText("Kodex")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /kodex \/home\/example\/kodex/i })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /add project/i }));
    expect(screen.queryByLabelText(/project name/i)).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/directory/i), "scratch");
    await userEvent.click(addProjectSubmitButton());

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/projects")).toHaveLength(1);
    });
    expect(await screen.findByRole("button", { name: /create ~\/scratch\?/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /cancel directory create/i }));
    expect(addProjectSubmitButton()).toBeInTheDocument();

    await userEvent.click(addProjectSubmitButton());
    expect(await screen.findByRole("button", { name: /create ~\/scratch\?/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /create ~\/scratch\?/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/projects")).toHaveLength(3);
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/projects")[0])).resolves.toEqual({ cwd: "scratch" });
    await expect(requestJson(gateway.callsFor("POST", "/v1/projects")[2])).resolves.toEqual({
      createDirectory: true,
      cwd: "scratch",
    });

    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: /new thread/i })).toHaveLength(1);
    expect(within(screen.getByRole("main", { name: /thread/i })).queryByRole("heading", { name: /new thread/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBeEnabled();
    const main = screen.getByRole("main", { name: /thread/i });
    expect(within(main).getByText(/good (morning|afternoon|evening)|burning the midnight oil\?/i)).toBeInTheDocument();
    const draftToolbar = within(main).getByRole("toolbar", { name: /draft thread toolbar/i });
    expect(within(draftToolbar).getByText("scratch")).toBeInTheDocument();
    expect(draftToolbar.querySelector(".lucide-folder")).toBeInTheDocument();
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
    expect(appCss).toMatch(/\.kodex-composer-underbar\s*\{[^}]*border-bottom-left-radius:\s*var\(--kodex-radius-composer\);/s);

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

    let createdThreadStream: FakeEventSource | undefined;
    await waitFor(() => {
      createdThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-2"));
      expect(createdThreadStream).toBeDefined();
    });
    act(() => {
      createdThreadStream?.emit({
        id: "event-title",
        seq: 2,
        kind: "codex.notification",
        codexMethod: "thread/nameUpdated",
        projectId: project.id,
        threadId: "thread-2",
        payload: { threadId: "thread-2", threadName: "Implement the next milestone" },
        receivedAt: "2026-04-30T00:00:01Z",
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

  it("shows the selected thread git branch under the composer and updates from thread metadata", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [{ ...thread, gitInfo: { branch: "feature/old-branch", originUrl: null, sha: null } }],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByText("feature/old-branch")).toBeInTheDocument();

    let selectedThreadStream: FakeEventSource | undefined;
    await waitFor(() => {
      selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
      expect(selectedThreadStream).toBeDefined();
    });
    act(() => {
      selectedThreadStream?.emitNamed("timeline.thread_metadata", {
        id: "event-thread-metadata",
        seq: 10,
        kind: "timeline.thread_metadata",
        codexMethod: "thread/metadata",
        threadId: "thread-1",
        turnId: null,
        itemId: null,
        projectId: project.id,
        payload: {
          source: "gatewayStream",
          thread: {
            ...thread,
            gitInfo: { branch: "feature/new-branch", originUrl: null, sha: null },
          },
        },
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    expect(await screen.findByText("feature/new-branch")).toBeInTheDocument();
    expect(screen.queryByText("feature/old-branch")).not.toBeInTheDocument();
  });

  it("preserves and clears git branch underflow from metadata patches", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [{ ...thread, gitInfo: { branch: "feature/old-branch", originUrl: null, sha: null } }],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByText("feature/old-branch")).toBeInTheDocument();

    let selectedThreadStream: FakeEventSource | undefined;
    await waitFor(() => {
      selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
      expect(selectedThreadStream).toBeDefined();
    });
    act(() => {
      selectedThreadStream?.emitNamed("timeline.thread_metadata", {
        id: "event-thread-metadata-sha",
        seq: 10,
        kind: "timeline.thread_metadata",
        codexMethod: "thread/metadata",
        threadId: "thread-1",
        turnId: null,
        itemId: null,
        projectId: project.id,
        payload: {
          source: "gatewayStream",
          threadId: "thread-1",
          thread: null,
          gitInfo: { sha: "abc123" },
        },
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    expect(await screen.findByText("feature/old-branch")).toBeInTheDocument();

    act(() => {
      selectedThreadStream?.emitNamed("timeline.thread_metadata", {
        id: "event-thread-metadata-clear",
        seq: 11,
        kind: "timeline.thread_metadata",
        codexMethod: "thread/metadata",
        threadId: "thread-1",
        turnId: null,
        itemId: null,
        projectId: project.id,
        payload: {
          source: "gatewayStream",
          threadId: "thread-1",
          thread: null,
          gitInfo: { branch: null },
        },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("feature/old-branch")).not.toBeInTheDocument();
    });
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

  it("creates chat threads from the first message without a project thread request", async () => {
    const chatThread = {
      ...thread,
      id: "chat-thread-1",
      name: "New thread",
      cwd: "/home/example/Documents/Codex/2026-05-05/plan-the-chat-sidebar",
      preview: "",
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/chats/threads": { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "POST /v1/chats/threads": { thread: chatThread, rawPayload: {} },
        "GET /v1/threads/chat-thread-1/queued-inputs": { queuedInputs: [] },
        "POST /v1/threads/chat-thread-1/turns": { payload: {} },
        "GET /v1/threads/chat-thread-1": threadDetail(
          { ...chatThread, preview: "Plan the chat sidebar implementation" },
          [],
        ),
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /new chat/i }));
    expect(gateway.callsFor("POST", "/v1/chats/threads")).toHaveLength(0);
    expect(within(screen.getByRole("main", { name: /thread/i })).queryByRole("heading", { name: /new thread/i })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/message composer/i), "Plan the chat sidebar implementation");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/chats/threads")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(0);
    await expect(requestJson(gateway.callsFor("POST", "/v1/chats/threads")[0])).resolves.toMatchObject({
      firstMessageText: "Plan the chat sidebar implementation",
    });
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/chat-thread-1/turns")).toHaveLength(1);
    });
    expect(
      await screen.findByRole("button", { name: /plan the chat sidebar implementation/i }),
    ).toBeInTheDocument();
  });

  it("keeps a locally created chat when the initial chat list resolves late", async () => {
    const initialChatThreads = deferred<unknown>();
    const chatThread = {
      ...thread,
      id: "chat-thread-1",
      name: "New thread",
      cwd: "/home/example/Documents/Codex/2026-05-05/keep-local-chat",
      preview: "",
    };
    mockGateway(
      baseRoutes({
        "GET /v1/chats/threads": () => initialChatThreads.promise,
        "POST /v1/chats/threads": { thread: chatThread, rawPayload: {} },
        "GET /v1/threads/chat-thread-1/queued-inputs": { queuedInputs: [] },
        "POST /v1/threads/chat-thread-1/turns": { payload: {} },
        "GET /v1/threads/chat-thread-1": threadDetail(
          { ...chatThread, preview: "Keep local chat" },
          [],
        ),
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /new chat/i }));
    await userEvent.type(screen.getByLabelText(/message composer/i), "Keep local chat");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByRole("button", { name: /keep local chat/i })).toBeInTheDocument();
    initialChatThreads.resolve({ threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} });

    expect(await screen.findByRole("button", { name: /keep local chat/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /keep local chat/i })).toBeInTheDocument();
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
    const kodexProjectTitle = within(kodexGroup).getByText("Kodex");
    expect(within(kodexGroup).queryByRole("button", { name: /kodex \/home\/example\/kodex/i })).not.toBeInTheDocument();
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();

    const scratchGroup = await screen.findByRole("group", { name: /scratch/i });
    expect(within(scratchGroup).queryByRole("button", { name: /scratch \/tmp\/scratch/i })).not.toBeInTheDocument();
    expect(within(scratchGroup).getByRole("button", { name: /second thread/i })).toBeInTheDocument();

    await userEvent.click(kodexProjectTitle);

    expect(within(kodexGroup).getByRole("button", { name: /expand kodex/i })).toHaveAttribute("aria-expanded", "false");
    expect(within(kodexGroup).queryByRole("button", { name: /implement frontend/i })).not.toBeInTheDocument();

    await userEvent.click(within(kodexGroup).getByRole("button", { name: /expand kodex/i }));

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
        "POST /v1/threads/thread-2/resume": {
          thread: { ...notLoadedThread, status: "idle" },
          rawPayload: {},
        },
        "GET /v1/threads/thread-2": threadDetail({ ...notLoadedThread, status: "idle" }, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Snapshot after resume" })]),
        ]),
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
    expect(await screen.findByText(/snapshot after resume/i)).toBeInTheDocument();
  });

  it("attaches active selected threads once while keeping live updates on the selected stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const runningThread = { ...secondThread, status: "active" };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, runningThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-2/resume": {
          thread: runningThread,
          rawPayload: {},
        },
        "GET /v1/threads/thread-2": threadDetail(runningThread, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Running snapshot" })]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/running snapshot/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/resume")).toHaveLength(1);
    });

    let selectedStream: FakeEventSource | undefined;
    await waitFor(() => {
      selectedStream = FakeEventSource.instances.find(
        (instance) => instance.url.includes("threadId=thread-2") && !instance.closed,
      );
      expect(selectedStream).toBeDefined();
    });
    act(() => {
      selectedStream?.emitNamed("timeline.item_upsert", {
        id: "event-live-agent",
        seq: 10,
        kind: "timeline.item_upsert",
        codexMethod: "item/started",
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "agent-live",
        projectId: project.id,
        payload: { item: { id: "agent-live", type: "agentMessage", text: "Live active update" } },
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });
    expect(await screen.findByText(/live active update/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /implement frontend/i }));
    await screen.findByText(/hello from codex/i);
    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    await screen.findByText(/running snapshot/i);

    expect(gateway.callsFor("POST", "/v1/threads/thread-2/resume")).toHaveLength(1);
  });

  it("remembers active thread attach success when selection changes before resume resolves", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const runningThread = { ...secondThread, status: "active" };
    const resumeDeferred = deferred<{ thread: typeof runningThread; rawPayload: Record<string, never> }>();
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, runningThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-2/resume": () => resumeDeferred.promise,
        "GET /v1/threads/thread-2": threadDetail(runningThread, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Running snapshot" })]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/running snapshot/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/resume")).toHaveLength(1);
    });

    await userEvent.click(screen.getByRole("button", { name: /implement frontend/i }));
    await screen.findByText(/hello from codex/i);

    await act(async () => {
      resumeDeferred.resolve({ thread: runningThread, rawPayload: {} });
      await resumeDeferred.promise;
    });

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    await screen.findByText(/running snapshot/i);

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/resume")).toHaveLength(1);
    });
  });

  it("provides compact narrow viewport navigation without a panel switcher", async () => {
    mockGateway(baseRoutes());

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: /mobile panels/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show sidebar/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /show sidebar/i }));
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "threads");
    expect(appCss).toMatch(/html,\s*body\s*\{[^}]*overflow:\s*hidden;/s);
    expect(appCss).toMatch(/\.kodex-shell\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/s);
    expect(appCss).toMatch(/@media \(max-width: 900px\)\s*\{[\s\S]*?\.kodex-main\s*\{[^}]*overflow:\s*hidden;/s);
    expect(appCss).toMatch(/@media \(max-width: 900px\)\s*\{[\s\S]*?\.kodex-thread-sidebar-button\s*\{[^}]*display:\s*inline-flex;/s);
  });

  it("keeps a sidebar escape hatch in the empty thread pane", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      }),
    );

    render(<App />);

    const main = await screen.findByRole("main", { name: /thread/i });
    expect(await within(main).findByText(/thread timeline/i)).toBeInTheDocument();
    expect(within(main).getByRole("button", { name: /show sidebar/i })).toBeInTheDocument();
    expect(within(main).getByRole("button", { name: /browse threads/i })).toBeInTheDocument();

    await userEvent.click(within(main).getByRole("button", { name: /browse threads/i }));
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "threads");
  });

  it("can close the narrow viewport sidebar without selecting a thread", async () => {
    mockGateway(baseRoutes());

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /show sidebar/i }));
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "threads");

    await userEvent.click(screen.getByRole("button", { name: /show thread/i }));
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "chat");
  });

  it("creates a chat from the narrow viewport Chats scope create action", async () => {
    const chatThread = {
      ...thread,
      id: "chat-thread-1",
      name: "New thread",
      cwd: "/home/example/Documents/Codex/2026-05-05/mobile-chat",
      preview: "",
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/chats/threads": { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "POST /v1/chats/threads": { thread: chatThread, rawPayload: {} },
        "GET /v1/threads/chat-thread-1/queued-inputs": { queuedInputs: [] },
        "GET /v1/threads/chat-thread-1": threadDetail(
          { ...chatThread, preview: "Start from mobile chats" },
          [],
        ),
        "POST /v1/threads/chat-thread-1/turns": { payload: {} },
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /show sidebar/i }));
    await userEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    await userEvent.click(screen.getByRole("button", { name: /create thread/i }));
    expect(appCss).toMatch(/\.kodex-sidebar-create-menu\s*\{[^}]*width:\s*min\(270px,\s*calc\(100vw - 24px\)\)\s*!important;/s);
    await userEvent.click(await screen.findByRole("menuitem", { name: /no project/i }));

    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "chat");
    await userEvent.type(screen.getByLabelText(/message composer/i), "Start from mobile chats");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/chats/threads")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(0);
  });

  it("creates a project draft from the narrow viewport create menu project choice", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/threads": { thread: { ...thread, id: "thread-2", name: "New thread", preview: "" }, rawPayload: {} },
        "GET /v1/threads/thread-2/queued-inputs": { queuedInputs: [] },
        "GET /v1/threads/thread-2": threadDetail({ ...thread, id: "thread-2", preview: "Start in project" }, []),
        "POST /v1/threads/thread-2/turns": { payload: {} },
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /show sidebar/i }));
    await userEvent.click(screen.getByRole("button", { name: /create thread/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: new RegExp(project.name, "i") }));

    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "chat");
    await userEvent.type(screen.getByLabelText(/message composer/i), "Start in project");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads")[0])).resolves.toMatchObject({
      projectId: project.id,
    });
    expect(gateway.callsFor("POST", "/v1/chats/threads")).toHaveLength(0);
  });

  it("returns narrow viewport navigation to chat after selecting or creating a thread", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /show sidebar/i }));
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "threads");

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "chat");

    await userEvent.click(screen.getByRole("button", { name: /show sidebar/i }));
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "threads");

    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "chat");
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
          name: "scratch",
          createdAt: "2026-04-30T00:00:00Z",
          updatedAt: "2026-04-30T00:00:00Z",
        }),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /add project/i }));
    await userEvent.type(screen.getByLabelText(/directory/i), "scratch");
    await userEvent.click(addProjectSubmitButton());

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

  it("selects the clicked thread when switching projects from the sidebar", async () => {
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
        "GET /v1/threads/thread-2": threadDetail(secondThread, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Second project snapshot" })]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /second thread/i }));

    expect(await screen.findByText(/second project snapshot/i)).toBeInTheDocument();
  });

  it("keeps the old active thread when a project title row is clicked", async () => {
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
    await userEvent.click(screen.getByText("Scratch"));

    expect(screen.getByLabelText(/message composer/i)).toBeEnabled();
    expect(screen.getByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();

    resolveSecondThreads({
      threads: [secondThread],
      nextCursor: null,
      backwardsCursor: null,
      rawPayload: {},
    });
    expect(screen.getByRole("button", { name: /expand scratch/i })).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByRole("button", { name: /expand scratch/i }));
    expect(await screen.findByRole("button", { name: /second thread/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
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

    const { container } = render(<App />);
    const view = within(container);

    const avatar = await view.findByRole("img", { name: /dev@example\.com/i });
    expect(avatar).toHaveTextContent("D");
    fireEvent.click(view.getByRole("button", { name: /account settings/i }));
    await userEvent.click(await view.findByRole("menuitem", { name: /logout/i }));
    expect(gateway.callsFor("POST", "/v1/account/logout")).toHaveLength(1);
    expect(await view.findByRole("button", { name: /connect chatgpt/i })).toBeInTheDocument();
  });

});
