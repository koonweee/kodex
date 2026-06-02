import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  projectionPatchEvent,
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

async function notificationMenuItem(name: RegExp) {
  let item: HTMLElement | undefined;
  await waitFor(() => {
    item = screen.queryAllByRole("menuitem", { hidden: true }).find((element) =>
      name.test(element.textContent ?? ""),
    );
    expect(item).toBeInTheDocument();
  });
  return item!;
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

function missingSidebarThreadsRoute() {
  return new Response(JSON.stringify({ code: "not_found", message: "Unhandled route", retryable: false }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MVP shell flows", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it(
    "renders projects and threads, creates a project, and promotes a draft thread title from the first message",
    async () => {
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
          "POST /v1/threads/thread-2/input": { payload: {} },
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
        expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(1);
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
          kind: "timeline.thread_metadata",
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
    },
    20_000,
  );

  it("does not render active app-server permission profiles as composer controls", async () => {
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
            model: "gpt-5.4",
            activePermissionProfile: { id: "full-access" },
          },
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /model: gpt-5\.4/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /permissions:/i })).not.toBeInTheDocument();
  }, 20_000);

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

  it("updates sidebar thread summaries from global metadata events", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(baseRoutes());

    render(<App />);

    const kodexGroup = await screen.findByRole("group", { name: /kodex/i });
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    expect(selectedThreadStream).toBeDefined();

    act(() => {
      selectedThreadStream?.emitNamed("timeline.thread_metadata", {
        id: "event-thread-metadata-sidebar",
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
            name: "Metadata renamed thread",
            gitInfo: { branch: "feature/sidebar", originUrl: null, sha: null },
          },
        },
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    expect(await within(kodexGroup).findByRole("button", { name: /metadata renamed thread/i })).toBeInTheDocument();
    expect(within(kodexGroup).queryByRole("button", { name: /implement frontend/i })).not.toBeInTheDocument();
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
    window.history.replaceState(null, "", "/threads/019de25f-9ac3-72b1-adf6-a108f82d1fb6");
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
        "POST /v1/threads/chat-thread-1/input": { payload: {} },
        "GET /v1/threads/chat-thread-1": threadDetail(
          { ...chatThread, preview: "Plan the chat sidebar implementation" },
          [],
        ),
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /start new chat from desktop header/i }));
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
      expect(gateway.callsFor("POST", "/v1/threads/chat-thread-1/input")).toHaveLength(1);
    });
    expect(
      await screen.findByRole("button", { name: /plan the chat sidebar implementation/i }),
    ).toBeInTheDocument();
  });

  it("opens the root draft chat page from the desktop sidebar header", async () => {
    window.history.replaceState(null, "", "/threads/thread-1");
    mockGateway(baseRoutes());

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /start new chat from desktop header/i }));

    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("button", { name: /project: no project/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBeEnabled();
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
        "POST /v1/threads/chat-thread-1/input": { payload: {} },
        "GET /v1/threads/chat-thread-1": threadDetail(
          { ...chatThread, preview: "Keep local chat" },
          [],
        ),
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /start new chat from desktop header/i }));
    await userEvent.type(screen.getByLabelText(/message composer/i), "Keep local chat");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByRole("button", { name: /keep local chat/i })).toBeInTheDocument();
    initialChatThreads.resolve({ threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} });

    expect(await screen.findByRole("button", { name: /keep local chat/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /keep local chat/i })).toBeInTheDocument();
  });

  it("keeps a locally created project thread when the initial project list resolves late", async () => {
    const initialProjectThreads = deferred<unknown>();
    const projectThread = {
      ...thread,
      id: "project-thread-2",
      name: "New thread",
      preview: "",
    };
    mockGateway(
      baseRoutes({
        "GET /v1/threads": () => initialProjectThreads.promise,
        "POST /v1/threads": { thread: projectThread, rawPayload: {} },
        "GET /v1/threads/project-thread-2/queued-inputs": { queuedInputs: [] },
        "POST /v1/threads/project-thread-2/input": { payload: {} },
        "GET /v1/threads/project-thread-2": threadDetail(
          { ...projectThread, preview: "Keep local project thread" },
          [],
        ),
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /create thread in kodex/i }));
    await userEvent.type(screen.getByLabelText(/message composer/i), "Keep local project thread");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByRole("button", { name: /keep local project thread/i })).toBeInTheDocument();
    initialProjectThreads.resolve({ threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} });

    expect(await screen.findByRole("button", { name: /keep local project thread/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /keep local project thread/i })).toBeInTheDocument();
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
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();

    await userEvent.click(within(kodexGroup).getByRole("button", { name: /expand kodex/i }));

    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
  });

  it("keeps unread, in-progress, and selected project threads visible when their project is collapsed", async () => {
    const inProgressThread = {
      ...activeThread,
      id: "thread-in-progress",
      name: "Running thread",
      unreadCompletedAgentTurn: false,
      updatedAt: thread.updatedAt + 2,
    };
    const selectedIdleThread = {
      ...thread,
      id: "thread-1",
      name: "Selected idle thread",
      unreadCompletedAgentTurn: false,
      updatedAt: thread.updatedAt,
    };
    const unreadThread = {
      ...thread,
      id: "thread-unread",
      name: "Unread thread",
      unreadCompletedAgentTurn: true,
      updatedAt: thread.updatedAt + 1,
    };
    const readThread = {
      ...secondThread,
      id: "thread-read",
      name: "Read thread",
      unreadCompletedAgentTurn: false,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [inProgressThread, unreadThread, selectedIdleThread, readThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    const kodexGroup = await screen.findByRole("group", { name: /kodex/i });
    expect(within(kodexGroup).getByRole("button", { name: /running thread/i })).toBeInTheDocument();
    expect(within(kodexGroup).getByRole("button", { name: /unread thread/i })).toBeInTheDocument();
    expect(within(kodexGroup).getByRole("button", { name: /selected idle thread/i })).toBeInTheDocument();
    expect(within(kodexGroup).getByRole("button", { name: /^read thread$/i })).toBeInTheDocument();

    await userEvent.click(within(kodexGroup).getByRole("button", { name: /collapse kodex/i }));

    const runningRow = within(kodexGroup).getByRole("button", { name: /running thread/i });
    const runningThreadRow = runningRow.closest(".kodex-thread-list-button");
    const unreadRow = within(kodexGroup).getByRole("button", { name: /unread thread/i });
    const unreadThreadRow = unreadRow.closest(".kodex-thread-list-button");
    const selectedRow = within(kodexGroup).getByRole("button", { name: /selected idle thread/i });
    expect(runningRow).toBeInTheDocument();
    expect(runningThreadRow).toBeInTheDocument();
    expect(unreadRow).toBeInTheDocument();
    expect(unreadThreadRow).toBeInTheDocument();
    expect(selectedRow).toBeInTheDocument();
    expect(within(kodexGroup).queryByRole("button", { name: /^read thread$/i })).not.toBeInTheDocument();
    expect(
      within(runningThreadRow as HTMLElement).getByRole("status", {
        name: /thread in progress/i,
      }),
    ).toBeInTheDocument();
    expect(
      within(unreadThreadRow as HTMLElement).getByRole("img", {
        name: /unread completed agent turn/i,
      }),
    ).toBeInTheDocument();
  });

  it("loads pinned project threads from the gateway and renders them in project lists", async () => {
    const pinnedThread = { ...thread, pinnedAt: "2026-05-06T12:00:00Z" };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/sidebar/threads": missingSidebarThreadsRoute,
        "GET /v1/threads": { threads: [secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/pinned": { threads: [pinnedThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      }),
    );

    render(<App />);

    await waitFor(() => expect(gateway.callsFor("GET", "/v1/sidebar/threads")).toHaveLength(1));
    await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads/pinned")).toHaveLength(1));
    const kodexGroup = await screen.findByRole("group", { name: /kodex/i });
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    expect(within(kodexGroup).getByRole("button", { name: /second thread/i })).toBeInTheDocument();
  });

  it("keeps pinned project rows visible while the pinned snapshot is pending", async () => {
    const pinnedThreads = deferred<unknown>();
    const pinnedThread = { ...thread, pinnedAt: "2026-05-06T12:00:00Z" };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/sidebar/threads": missingSidebarThreadsRoute,
        "GET /v1/threads": { threads: [pinnedThread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/pinned": () => pinnedThreads.promise,
      }),
    );

    render(<App />);

    const kodexGroup = await screen.findByRole("group", { name: /kodex/i });
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads/pinned")).toHaveLength(1));

    pinnedThreads.resolve({ threads: [pinnedThread], nextCursor: null, backwardsCursor: null, rawPayload: {} });

    await waitFor(() => expect(screen.queryByText("Pinned")).not.toBeInTheDocument());
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
  });

  it("seeds the sidebar from the gateway snapshot endpoint", async () => {
    const pinnedThread = { ...thread, pinnedAt: "2026-05-06T12:00:00Z" };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [pinnedThread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/sidebar/threads": {
          projects: [project],
          projectThreads: {
            [project.id]: {
              threads: [pinnedThread, secondThread],
              nextCursor: "project-next",
              backwardsCursor: null,
              rawPayload: {},
            },
          },
          chatThreads: { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
          pinnedThreads: { threads: [pinnedThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        },
      }),
    );

    render(<App />);

    await waitFor(() => expect(gateway.callsFor("GET", "/v1/sidebar/threads")).toHaveLength(1));
    const kodexGroup = await screen.findByRole("group", { name: /kodex/i });
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    expect(within(kodexGroup).getByRole("button", { name: /second thread/i })).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/sidebar/threads")).toHaveLength(1);
    expect(gateway.callsFor("GET", "/v1/threads")).toHaveLength(0);
    expect(gateway.callsFor("GET", "/v1/chats/threads")).toHaveLength(0);
    expect(gateway.callsFor("GET", "/v1/threads/pinned")).toHaveLength(0);
  });

  it("uses scoped endpoints for invalidated sidebar sections after a startup snapshot", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const chatThread = {
      ...thread,
      id: "chat-thread-1",
      name: "Chat starter",
      cwd: "/home/example/Documents/Codex/2026-05-09/chat-starter",
      preview: "Chat starter",
    };
    const untitledProjectThread = { ...thread, id: "project-thread-missing-title", name: null, preview: "" };
    const untitledChatThread = { ...chatThread, name: null, preview: "" };
    const hydratedProjectThread = {
      ...untitledProjectThread,
      preview: "Updated project preview",
      updatedAt: thread.updatedAt + 1,
    };
    const hydratedChatThread = {
      ...untitledChatThread,
      preview: "Updated chat preview",
      updatedAt: chatThread.updatedAt + 1,
    };
    const pinnedThread = {
      ...thread,
      id: "unknown-pinned-thread",
      name: "Pinned elsewhere",
      pinnedAt: "2026-05-09T12:00:00Z",
      updatedAt: thread.updatedAt + 2,
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": () => ({
          threads: [hydratedProjectThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        }),
        "GET /v1/chats/threads": () => ({
          threads: [hydratedChatThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        }),
        "GET /v1/threads/pinned": () => ({
          threads: [pinnedThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        }),
        "GET /v1/sidebar/threads": {
          projects: [project],
          projectThreads: {
            [project.id]: {
              threads: [untitledProjectThread],
              nextCursor: null,
              backwardsCursor: null,
              rawPayload: {},
            },
          },
          chatThreads: { threads: [untitledChatThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
          pinnedThreads: { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        },
      }),
    );

    render(<App />);

    await waitFor(() => expect(gateway.callsFor("GET", "/v1/sidebar/threads")).toHaveLength(1));
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    expect(gateway.callsFor("GET", "/v1/threads")).toHaveLength(0);
    expect(gateway.callsFor("GET", "/v1/chats/threads")).toHaveLength(0);
    expect(gateway.callsFor("GET", "/v1/threads/pinned")).toHaveLength(0);
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalStream).toBeDefined();

    act(() => {
      globalStream?.emitNamed("thread_view.patch", projectionPatchEvent({
        id: "event-project-refresh",
        seq: 2,
        projectId: project.id,
        threadId: untitledProjectThread.id,
        turnId: "turn-1",
        itemId: "item-1",
        itemType: "userMessage",
        text: "Updated project preview",
      }));
      globalStream?.emitNamed("thread_view.patch", projectionPatchEvent({
        id: "event-chat-refresh",
        seq: 3,
        projectId: null,
        threadId: untitledChatThread.id,
        turnId: "turn-2",
        itemId: "item-2",
        itemType: "userMessage",
        text: "Updated chat preview",
      }));
      globalStream?.emitNamed("thread.pin_updated", {
        id: "event-unknown-pin",
        seq: 4,
        kind: "thread.pin_updated",
        codexMethod: "thread/pin_updated",
        projectId: null,
        threadId: pinnedThread.id,
        payload: { threadId: pinnedThread.id, pinnedAt: pinnedThread.pinnedAt },
        receivedAt: "2026-05-09T12:00:00Z",
      });
    });

    await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads")).toHaveLength(1));
    await waitFor(() => expect(gateway.callsFor("GET", "/v1/chats/threads")).toHaveLength(1));
    await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads/pinned")).toHaveLength(1));
  });

  it("appends cursor-backed sidebar pages and ignores duplicate load-more clicks", async () => {
    const projectThreads = Array.from({ length: 5 }, (_value, index) => ({
      ...thread,
      id: `project-thread-${index + 1}`,
      name: `Project thread ${index + 1}`,
      updatedAt: thread.updatedAt + index,
    }));
    const nextProjectThread = {
      ...thread,
      id: "project-thread-next",
      name: "Project thread next",
      updatedAt: thread.updatedAt + 10,
    };
    const chatThreads = Array.from({ length: 5 }, (_value, index) => ({
      ...thread,
      cwd: `/home/example/Documents/Codex/2026-05-09/chat-${index + 1}`,
      id: `chat-thread-${index + 1}`,
      name: `Chat thread ${index + 1}`,
      updatedAt: thread.updatedAt + index,
    }));
    const nextChatThread = {
      ...thread,
      cwd: "/home/example/Documents/Codex/2026-05-09/chat-next",
      id: "chat-thread-next",
      name: "Chat thread next",
      updatedAt: thread.updatedAt + 10,
    };
    const projectPage = deferred<unknown>();
    const chatPage = deferred<unknown>();
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": (request: Request) => {
          const url = new URL(request.url);
          if (url.searchParams.get("cursor") === "project-next") {
            return projectPage.promise;
          }
          return { threads: projectThreads, nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
        "GET /v1/chats/threads": (request: Request) => {
          const url = new URL(request.url);
          if (url.searchParams.get("cursor") === "chat-next") {
            return chatPage.promise;
          }
          return { threads: chatThreads, nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
        "GET /v1/sidebar/threads": {
          projects: [project],
          projectThreads: {
            [project.id]: {
              threads: projectThreads,
              nextCursor: "project-next",
              backwardsCursor: null,
              rawPayload: {},
            },
          },
          chatThreads: { threads: chatThreads, nextCursor: "chat-next", backwardsCursor: null, rawPayload: {} },
          pinnedThreads: { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        },
      }),
    );

    render(<App />);

    const kodexGroup = await screen.findByRole("group", { name: /kodex/i });
    await waitFor(() => expect(gateway.callsFor("GET", "/v1/sidebar/threads")).toHaveLength(1));
    expect(gateway.callsFor("GET", "/v1/threads")).toHaveLength(0);
    fireEvent.click(within(kodexGroup).getByRole("button", { name: "Show more" }));
    fireEvent.click(within(kodexGroup).getByRole("button", { name: "Loading more" }));
    expect(gateway.callsFor("GET", "/v1/threads")).toHaveLength(1);

    act(() => {
      projectPage.resolve({ threads: [nextProjectThread], nextCursor: null, backwardsCursor: null, rawPayload: {} });
    });
    expect(await within(kodexGroup).findByRole("button", { name: /project thread next/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    expect(gateway.callsFor("GET", "/v1/chats/threads")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    fireEvent.click(screen.getByRole("button", { name: "Loading more" }));
    expect(gateway.callsFor("GET", "/v1/chats/threads")).toHaveLength(1);

    act(() => {
      chatPage.resolve({ threads: [nextChatThread], nextCursor: null, backwardsCursor: null, rawPayload: {} });
    });
    expect(await screen.findByRole("button", { name: /chat thread next/i })).toBeInTheDocument();
  });

  it("moves pinned rows from live pin events while the pinned snapshot is pending", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const pinnedThreads = deferred<unknown>();
    mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/pinned": () => pinnedThreads.promise,
      }),
    );

    render(<App />);

    const kodexGroup = await screen.findByRole("group", { name: /kodex/i });
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    expect(selectedThreadStream).toBeDefined();

    act(() => {
      selectedThreadStream?.emitNamed("thread.pin_updated", {
        id: "event-pin-thread-1",
        seq: 2,
        kind: "thread.pin_updated",
        codexMethod: "thread/pin_updated",
        projectId: project.id,
        threadId: thread.id,
        payload: { threadId: thread.id, pinnedAt: "2026-05-06T12:00:00Z" },
        receivedAt: "2026-05-06T12:00:00Z",
      });
    });

    await waitFor(() => expect(screen.queryByText("Pinned")).not.toBeInTheDocument());
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();

    await act(async () => {
      pinnedThreads.resolve({ threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} });
      await pinnedThreads.promise;
    });
    expect(screen.queryByText("Pinned")).not.toBeInTheDocument();
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();

    act(() => {
      selectedThreadStream?.emitNamed("thread.pin_updated", {
        id: "event-unpin-thread-1",
        seq: 3,
        kind: "thread.pin_updated",
        codexMethod: "thread/pin_updated",
        projectId: project.id,
        threadId: thread.id,
        payload: { threadId: thread.id, pinnedAt: null },
        receivedAt: "2026-05-06T12:00:01Z",
      });
    });

    await waitFor(() => expect(screen.queryByText("Pinned")).not.toBeInTheDocument());
    expect(within(kodexGroup).getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
  });

  it("inserts gateway-created project and chat threads from live upsert events", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(baseRoutes());

    render(<App />);

    const kodexGroup = await screen.findByRole("group", { name: /kodex/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalStream).toBeDefined();

    const projectThread = {
      ...thread,
      id: "thread-live-project",
      name: "Live project thread",
      preview: "Created elsewhere",
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: false,
      updatedAt: thread.updatedAt + 1,
    };
    act(() => {
      globalStream?.emitNamed("thread.upserted", {
        id: "event-project-thread",
        seq: 2,
        kind: "thread.upserted",
        codexMethod: null,
        projectId: project.id,
        threadId: projectThread.id,
        payload: { scope: "project", projectId: project.id, thread: projectThread },
        receivedAt: "2026-05-09T12:00:00Z",
      });
    });

    await waitFor(() =>
      expect(within(kodexGroup).getByRole("button", { name: /live project thread/i })).toBeInTheDocument(),
    );

    const chatThread = {
      ...thread,
      id: "thread-live-chat",
      name: "Live chat thread",
      cwd: "/home/example/Documents/Codex/2026-05-09/live-chat-thread",
      preview: "Created elsewhere",
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: false,
      updatedAt: thread.updatedAt + 2,
    };
    act(() => {
      globalStream?.emitNamed("thread.upserted", {
        id: "event-chat-thread",
        seq: 3,
        kind: "thread.upserted",
        codexMethod: null,
        projectId: null,
        threadId: chatThread.id,
        payload: { scope: "chat", projectId: null, thread: chatThread },
        receivedAt: "2026-05-09T12:00:01Z",
      });
    });

    await userEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /live chat thread/i })).toBeInTheDocument());
  });

  it("refreshes a live-created chat thread after its first timeline item gives it a preview", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const pendingChatThread = {
      ...thread,
      id: "thread-live-chat-pending",
      name: null,
      cwd: "/home/example/Documents/Codex/2026-05-09/live-chat-pending",
      preview: "",
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: false,
      updatedAt: thread.updatedAt + 1,
    };
    const hydratedChatThread = {
      ...pendingChatThread,
      preview: "First message from another tab",
      updatedAt: thread.updatedAt + 2,
    };
    let chatListCalls = 0;
    mockGateway(
      baseRoutes({
        "GET /v1/chats/threads": () => {
          chatListCalls += 1;
          const threads =
            chatListCalls === 1 ? [] : chatListCalls === 2 ? [pendingChatThread] : [hydratedChatThread];
          return { threads, nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
      }),
    );

    render(<App />);

    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalStream).toBeDefined();
    await waitFor(() => expect(chatListCalls).toBeGreaterThanOrEqual(1));

    act(() => {
      globalStream?.emitNamed("thread.upserted", {
        id: "event-chat-thread-pending",
        seq: 2,
        kind: "thread.upserted",
        codexMethod: null,
        projectId: null,
        threadId: pendingChatThread.id,
        payload: { scope: "chat", projectId: null, thread: pendingChatThread },
        receivedAt: "2026-05-09T12:00:01Z",
      });
    });

    await userEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /new thread/i })).toBeInTheDocument());
    await waitFor(() => expect(chatListCalls).toBeGreaterThanOrEqual(2));

    act(() => {
      globalStream?.emitNamed("thread_view.patch", projectionPatchEvent({
        id: "event-chat-first-item",
        seq: 3,
        projectId: null,
        threadId: pendingChatThread.id,
        turnId: "turn-1",
        itemId: "item-1",
        itemType: "userMessage",
        text: "First message from another tab",
      }));
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /first message from another tab/i })).toBeInTheDocument(),
    );
    expect(chatListCalls).toBeGreaterThanOrEqual(3);
  });

  it("updates titled chat ordering from live timeline completion without refetching the section", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const staleActiveChat = {
      ...thread,
      id: "thread-chat-active",
      name: "Active chat",
      cwd: "/home/example/Documents/Codex/2026-05-09/active-chat",
      preview: "Active chat",
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: false,
      updatedAt: thread.updatedAt + 1,
    };
    const recentChat = {
      ...thread,
      id: "thread-chat-recent",
      name: "Recent chat",
      cwd: "/home/example/Documents/Codex/2026-05-09/recent-chat",
      preview: "Recent chat",
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: false,
      updatedAt: thread.updatedAt + 2,
    };
    let chatListCalls = 0;
    mockGateway(
      baseRoutes({
        "GET /v1/chats/threads": () => {
          chatListCalls += 1;
          return { threads: [recentChat, staleActiveChat], nextCursor: null, backwardsCursor: null, rawPayload: {} };
        },
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /^chats$/i }));
    await waitFor(() => expect(chatListCalls).toBeGreaterThanOrEqual(1));
    let activeRow = screen.getByRole("button", { name: /active chat/i }).closest(".kodex-thread-list-button");
    let recentRow = screen.getByRole("button", { name: /recent chat/i }).closest(".kodex-thread-list-button");
    expect(activeRow).toBeInTheDocument();
    expect(recentRow).toBeInTheDocument();
    expect(recentRow!.compareDocumentPosition(activeRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    act(() => {
      globalStream?.emitNamed("thread_view.patch", {
        id: "event-chat-active-completed",
        seq: 2,
        kind: "thread_view.patch",
        codexMethod: "thread_view/patch",
        projectId: null,
        threadId: staleActiveChat.id,
        turnId: null,
        itemId: null,
        payload: {
          scope: "lifecycle",
          viewRevision: 2,
          threadId: staleActiveChat.id,
          activeTurnId: null,
          liveState: "idle",
          items: [],
        },
        receivedAt: "2026-05-09T12:00:01Z",
      });
    });

    await waitFor(() => {
      activeRow = screen.getByRole("button", { name: /active chat/i }).closest(".kodex-thread-list-button");
      recentRow = screen.getByRole("button", { name: /recent chat/i }).closest(".kodex-thread-list-button");
      expect(activeRow!.compareDocumentPosition(recentRow!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    expect(chatListCalls).toBe(1);
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
    await clickMenuItem(/archive thread/i);

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/archive")).toHaveLength(1);
    });
    expect(screen.getByLabelText(/message composer/i)).toBeEnabled();
    expect(screen.queryByText(/select or create a thread/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /project: kodex/i })).toBeInTheDocument();
  });

  it("pins and unpins the selected thread from the thread actions menu", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/threads/thread-1/pin": { threadId: "thread-1", pinnedAt: "2026-05-06T12:00:00Z" },
        "DELETE /v1/threads/thread-1/pin": { threadId: "thread-1", pinnedAt: null },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
    await clickMenuItem(/pin thread/i);

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/pin")).toHaveLength(1);
    });
    await waitFor(() => expect(screen.queryByText("Pinned")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /implement frontend/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
    await clickMenuItem(/unpin thread/i);

    await waitFor(() => {
      expect(gateway.callsFor("DELETE", "/v1/threads/thread-1/pin")).toHaveLength(1);
    });
    await waitFor(() => expect(screen.queryByText("Pinned")).not.toBeInTheDocument());
  });

  it("toggles selected thread notifications from the thread actions menu", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "PATCH /v1/threads/thread-1/notifications": async (request: Request) => {
          const body = (await requestJson(request)) as { enabled: boolean };
          return {
            threadId: "thread-1",
            notificationsEnabled: body.enabled,
            updatedAt: "2026-05-25T12:00:00Z",
          };
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
    const toggle = await notificationMenuItem(/notifications/i);
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/notifications")).toHaveLength(1);
    });
    await expect(requestJson(gateway.callsFor("PATCH", "/v1/threads/thread-1/notifications")[0])).resolves.toEqual({
      enabled: false,
    });
    await waitFor(() => {
      expect(
        screen.queryAllByRole("menuitem", { hidden: true }).find((element) =>
          /notifications/i.test(element.textContent ?? ""),
        ),
      ).toHaveAttribute("aria-checked", "false");
    });
    expect(screen.getByRole("button", { name: /thread actions/i })).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(await notificationMenuItem(/notifications/i));

    await waitFor(() => {
      expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/notifications")).toHaveLength(2);
    });
    await expect(requestJson(gateway.callsFor("PATCH", "/v1/threads/thread-1/notifications")[1])).resolves.toEqual({
      enabled: true,
    });
  });

  it("reflects notification setting updates from another client through SSE", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(baseRoutes());

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    expect(selectedThreadStream).toBeDefined();

    act(() => {
      selectedThreadStream?.emit({
        id: "event-thread-notifications",
        seq: 10,
        kind: "thread.notifications_updated",
        codexMethod: null,
        threadId: "thread-1",
        turnId: null,
        itemId: null,
        projectId: project.id,
        payload: {
          threadId: "thread-1",
          notificationsEnabled: false,
          updatedAt: "2026-05-25T12:00:00Z",
        },
        receivedAt: "2026-05-25T12:00:00Z",
      });
    });

    await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
    expect(await notificationMenuItem(/notifications/i)).toHaveAttribute("aria-checked", "false");
  });

  it("renames the selected thread from the thread actions menu", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "PATCH /v1/threads/thread-1/name": async (request: Request) => {
          const body = (await requestJson(request)) as { name: string };
          return { thread: { ...thread, name: body.name, updatedAt: thread.updatedAt + 1 } };
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
    await clickMenuItem(/rename thread/i);
    const input = await screen.findByLabelText(/thread name/i);
    expect(input).toHaveValue("Implement frontend");

    await userEvent.clear(input);
    await userEvent.type(input, "  Renamed from menu  ");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));

    await waitFor(() => {
      expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/name")).toHaveLength(1);
    });
    await expect(requestJson(gateway.callsFor("PATCH", "/v1/threads/thread-1/name")[0])).resolves.toEqual({
      name: "Renamed from menu",
    });
    expect(await screen.findByRole("heading", { name: /renamed from menu/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /renamed from menu/i })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /rename thread/i })).not.toBeInTheDocument();
    });
  });

  it("validates and preserves rename input when the gateway rejects the request", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "PATCH /v1/threads/thread-1/name": new Response(
          JSON.stringify({ message: "app-server refused the thread name" }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
    await clickMenuItem(/rename thread/i);
    const input = await screen.findByLabelText(/thread name/i);
    await userEvent.clear(input);
    await userEvent.type(input, "   ");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));

    expect(await screen.findByText(/thread name cannot be empty/i)).toBeInTheDocument();
    expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/name")).toHaveLength(0);

    await userEvent.clear(input);
    await userEvent.type(input, "Rejected rename");
    await userEvent.click(screen.getByRole("button", { name: /^rename$/i }));

    await waitFor(() => {
      expect(gateway.callsFor("PATCH", "/v1/threads/thread-1/name")).toHaveLength(1);
    });
    expect(await screen.findByText(/app-server refused the thread name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/thread name/i)).toHaveValue("Rejected rename");
    expect(screen.getByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
  });

  it("starts unnamed thread renames from an empty field while using preview as the placeholder", async () => {
    const unnamedThread = {
      ...thread,
      name: null,
      preview: "Preview title for unnamed thread",
    };
    mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [unnamedThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-1": threadDetail(unnamedThread, []),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /preview title for unnamed thread/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
    await clickMenuItem(/rename thread/i);

    const input = await screen.findByLabelText(/thread name/i);
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Preview title for unnamed thread");
  });

  it("converges selected and sidebar thread titles from another client's name event", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(baseRoutes());

    render(<App />);

    const kodexGroup = await screen.findByRole("group", { name: /kodex/i });
    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    expect(selectedThreadStream).toBeDefined();

    act(() => {
      selectedThreadStream?.emit({
        id: "event-thread-name-sidebar",
        seq: 10,
        kind: "timeline.thread_metadata",
        codexMethod: "thread/name/updated",
        threadId: "thread-1",
        turnId: null,
        itemId: null,
        projectId: project.id,
        payload: { threadId: "thread-1", threadName: "Renamed in another tab" },
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    expect(await screen.findByRole("heading", { name: /renamed in another tab/i })).toBeInTheDocument();
    expect(within(kodexGroup).getByRole("button", { name: /renamed in another tab/i })).toBeInTheDocument();
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

  it("returns to a project draft when archiving the selected thread from the selector hover action", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/threads/thread-1/archive": { payload: {} },
      }),
    );

    render(<App />);

    const selectedThreadButton = await screen.findByRole("button", { name: /implement frontend/i });
    await userEvent.hover(selectedThreadButton);
    await userEvent.click(screen.getByRole("button", { name: /archive implement frontend/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/archive")).toHaveLength(1);
    });
    const main = screen.getByRole("main", { name: /thread/i });
    expect(within(main).queryByText(/select or create a thread/i)).not.toBeInTheDocument();
    expect(within(main).getByLabelText(/message composer/i)).toBeEnabled();
    expect(main.querySelector(".kodex-main-stack")).toHaveAttribute("data-draft-thread", "true");
    expect(within(main).getByRole("button", { name: /project: kodex/i })).toBeInTheDocument();
  });

  it("returns to a chat draft when archiving the selected chat thread", async () => {
    const chatThread = { ...thread, source: "chat" };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/chats/threads": { threads: [chatThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-1": threadDetail(chatThread, [
          snapshotTurn("turn-1", [snapshotItem("item-1", "agentMessage", { text: "Hello from chat" })]),
        ]),
        "POST /v1/threads/thread-1/archive": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
    await clickMenuItem(/archive thread/i);

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/archive")).toHaveLength(1);
    });
    const main = screen.getByRole("main", { name: /thread/i });
    expect(within(main).queryByText(/select or create a thread/i)).not.toBeInTheDocument();
    expect(within(main).getByLabelText(/message composer/i)).toBeEnabled();
    expect(main.querySelector(".kodex-main-stack")).toHaveAttribute("data-draft-thread", "true");
    expect(within(main).getByRole("button", { name: /project: no project/i })).toBeInTheDocument();
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
    const progressIndicator = runningThreadRow?.querySelector<HTMLElement>(".kodex-thread-progress-indicator") ?? null;
    expect(runningThreadRow).toBeInTheDocument();
    expect(within(runningThreadRow as HTMLElement).getByLabelText(/thread in progress/i)).toContainElement(
      progressIndicator,
    );
    expect(within(runningThreadRow as HTMLElement).queryByRole("button", { name: /archive running thread/i })).not.toBeInTheDocument();

    await userEvent.hover(runningThreadButton);

    expect(within(runningThreadRow as HTMLElement).getByRole("button", { name: /archive running thread/i })).toBeInTheDocument();
    expect(within(runningThreadRow as HTMLElement).queryByLabelText(/thread in progress/i)).not.toBeInTheDocument();
  });

  it("hides thread loading state and attaches not-loaded threads on selection", async () => {
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
        "POST /v1/threads/thread-2/attach": {
          disposition: "resumed",
          thread: { ...notLoadedThread, status: "idle" },
          rawPayload: {},
        },
        "GET /v1/threads/thread-2": threadDetail({ ...notLoadedThread, status: "idle" }, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Snapshot after attach" })]),
        ]),
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resume thread/i })).not.toBeInTheDocument();
    expect(container.querySelector(".kodex-thread-status")).not.toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/attach")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/attach")).toHaveLength(1);
    });
    expect(await screen.findByText(/snapshot after attach/i)).toBeInTheDocument();
  });

  it("reattaches active selected threads on re-selection while keeping live updates on the selected stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const runningThread = { ...secondThread, status: "active" };
    window.history.replaceState(null, "", "/threads/thread-2");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, runningThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-2/attach": {
          disposition: "resumed",
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
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/attach")).toHaveLength(1);
    });

    let selectedStream: FakeEventSource | undefined;
    await waitFor(() => {
      selectedStream = FakeEventSource.instances.find(
        (instance) => instance.url.includes("threadId=thread-2") && !instance.closed,
      );
      expect(selectedStream).toBeDefined();
    });
    act(() => {
      selectedStream?.emitNamed("thread_view.patch", projectionPatchEvent({
        id: "event-live-agent",
        seq: 10,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "agent-live",
        projectId: project.id,
        text: "Live active update",
        displayOrder: 10,
      }));
    });
    expect(await screen.findByText(/live active update/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /implement frontend/i }));
    await screen.findByText(/hello from codex/i);
    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    await screen.findByText(/running snapshot/i);

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/attach")).toHaveLength(2);
    });
  });

  it("does not remember active thread attach no-op dispositions in the browser", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const runningThread = { ...secondThread, status: "active" };
    window.history.replaceState(null, "", "/threads/thread-2");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, runningThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-2/attach": {
          disposition: "alreadyLoaded",
          thread: null,
        },
        "GET /v1/threads/thread-2": threadDetail(runningThread, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Loaded snapshot" })]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/loaded snapshot/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/attach")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/resume")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /implement frontend/i }));
    await screen.findByText(/hello from codex/i);
    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    await screen.findByText(/loaded snapshot/i);

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/attach")).toHaveLength(2);
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/resume")).toHaveLength(0);
  });

  it("dedupes only in-flight active thread attach requests when selection changes before attach resolves", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const runningThread = { ...secondThread, status: "active" };
    const attachDeferred = deferred<{ disposition: "resumed"; thread: typeof runningThread; rawPayload: Record<string, never> }>();
    window.history.replaceState(null, "", "/threads/thread-2");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, runningThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-2/attach": () => attachDeferred.promise,
        "GET /v1/threads/thread-2": threadDetail(runningThread, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Running snapshot" })]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/running snapshot/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/attach")).toHaveLength(1);
    });

    await userEvent.click(screen.getByRole("button", { name: /implement frontend/i }));
    await screen.findByText(/hello from codex/i);

    await act(async () => {
      attachDeferred.resolve({ disposition: "resumed", thread: runningThread, rawPayload: {} });
      await attachDeferred.promise;
    });

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    await screen.findByText(/running snapshot/i);

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/attach")).toHaveLength(2);
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
    expect(appCss).toMatch(/@media \(max-width: 900px\)\s*\{[\s\S]*?\.kodex-sidebar-mobile-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*44px\s*44px;/s);
    expect(appCss).toMatch(/\.kodex-sidebar-scope-switch\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(0,\s*1fr\);/s);
  });

  it("keeps a sidebar escape hatch on the root draft chat pane", async () => {
    window.history.replaceState(null, "", "/");
    mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /project: no project/i })).toBeInTheDocument();
    const main = screen.getByRole("main", { name: /thread/i });
    expect(within(main).getByRole("button", { name: /show sidebar/i })).toBeInTheDocument();

    await userEvent.click(within(main).getByRole("button", { name: /show sidebar/i }));
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
        "POST /v1/threads/chat-thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /show sidebar/i }));
    await userEvent.click(screen.getByRole("button", { name: /^chats$/i }));
    await userEvent.click(screen.getByRole("button", { name: /start new chat from mobile header/i }));

    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "chat");
    expect(window.location.pathname).toBe("/");
    expect(screen.getByRole("button", { name: /project: no project/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /no project/i })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Start from mobile chats");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/chats/threads")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(0);
  });

  it("creates a project draft from the narrow viewport root project selector", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "POST /v1/threads": { thread: { ...thread, id: "thread-2", name: "New thread", preview: "" }, rawPayload: {} },
        "GET /v1/threads/thread-2/queued-inputs": { queuedInputs: [] },
        "GET /v1/threads/thread-2": threadDetail({ ...thread, id: "thread-2", preview: "Start in project" }, []),
        "POST /v1/threads/thread-2/input": { payload: {} },
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /show sidebar/i }));
    await userEvent.click(screen.getByRole("button", { name: /start new chat from mobile header/i }));
    await userEvent.click(screen.getByRole("button", { name: /project: no project/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: new RegExp(project.name, "i") }));

    expect(document.querySelector(".kodex-shell")).toHaveAttribute("data-mobile-panel", "chat");
    expect(screen.getByRole("button", { name: new RegExp(`project: ${project.name}`, "i") })).toBeInTheDocument();
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

  it("opens a draft thread immediately after creating a project", async () => {
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
    expect(screen.getByLabelText(/message composer/i)).toBeEnabled();
    expect(screen.queryByText(/select or create a thread/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /project: scratch/i })).toBeInTheDocument();

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
        "POST /v1/threads/thread-1/input": { payload: {} },
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
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(2);
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
    expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
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
