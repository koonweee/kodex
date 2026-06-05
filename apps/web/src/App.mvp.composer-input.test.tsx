import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  projectionPatchEvent,
  requestJson,
  secondThread,
  setInitialWorkspacePaneState,
  snapshotItem,
  snapshotTurn,
  thread,
  threadDetail,
  timelineElement,
} from "./test/mvpAppHarness";

function clickMenuItem(name: RegExp) {
  return clickMenuItemWithDeps(name, screen, waitFor, fireEvent);
}

function latestFakeEventSource(predicate: (instance: FakeEventSource) => boolean) {
  return [...FakeEventSource.instances].reverse().find(predicate);
}

function hasThreadId(instance: FakeEventSource, threadId: string) {
  const params = new URL(instance.url, window.location.origin).searchParams;
  const threadIds = (params.get("threadIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return params.get("threadId") === threadId || threadIds.includes(threadId);
}

function workspaceNavigation() {
  return screen.getByRole("navigation", { name: /workspace/i });
}

function threadPaneByHeading(name: RegExp) {
  const pane = screen.getByRole("heading", { name }).closest(".kodex-thread-pane");
  expect(pane).toBeInTheDocument();
  return pane as HTMLElement;
}

function activeThreadPane() {
  const pane = document.querySelector<HTMLElement>('.kodex-thread-pane[data-workspace-pane-active="true"]');
  expect(pane).toBeInTheDocument();
  return pane as HTMLElement;
}

function composerInActiveThreadPane() {
  return within(activeThreadPane()).getByLabelText(/message composer/i);
}

function sendButtonInActiveThreadPane() {
  return within(activeThreadPane()).getByRole("button", { name: /send message/i });
}

function attachmentInputInActiveThreadPane() {
  const input = activeThreadPane().querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  return input as HTMLInputElement;
}

function composerInThreadPane(name: RegExp) {
  return within(threadPaneByHeading(name)).getByLabelText(/message composer/i);
}

function sendButtonInThreadPane(name: RegExp) {
  return within(threadPaneByHeading(name)).getByRole("button", { name: /send message/i });
}

async function expectHelloFromCodex() {
  await waitFor(() => {
    expect(screen.getByText(/hello from codex/i)).toBeInTheDocument();
  });
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

async function queuedThreadInputResponse(request: Request, queueId: string, threadId = "thread-1") {
  const body = (await request.json()) as { input?: Array<{ type: string; text?: string }> };
  return {
    disposition: "queued",
    queuedInput: {
      id: queueId,
      threadId,
      input: body.input ?? [],
      options: {},
      status: "queued",
      priority: "normal",
      attemptCount: 0,
      lastError: null,
      createdAt: "2026-05-05T00:00:00Z",
      updatedAt: "2026-05-05T00:00:00Z",
    },
    rawPayload: null,
  };
}

describe("MVP composer input flows", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("replays timeline events and uses one composer for idle send, active stop, and queued steering", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "POST /v1/threads/thread-1/input": { payload: {} },
        "POST /v1/threads/thread-1/interrupt-current": {
          disposition: "interrupted",
          interruptedTurnId: "fresh-turn",
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    await expectHelloFromCodex();
    expect(screen.getByLabelText(/message composer/i)).toBeEnabled();
    expect(screen.queryByLabelText(/steer active turn/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
    const stopButtons = screen.getAllByRole("button", { name: /stop turn/i });
    expect(stopButtons).toHaveLength(1);
    expect(stopButtons[0]).toBeEnabled();
    expect(stopButtons[0].querySelector("svg rect, svg path")).toBeInTheDocument();

    await userEvent.click(stopButtons[0]);
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/interrupt-current")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/interrupt")).toHaveLength(0);
  });

  it("starts idle turns with the main composer action", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const turnStart = deferred<unknown>();
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": () => turnStart.promise,
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
    await clickMenuItem(/add attachment/i);
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: /add attachment/i })).not.toBeInTheDocument();
    });

    await userEvent.type(screen.getByLabelText(/message composer/i), "Ship it");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
    expect(within(timelineElement(container)).getByText("Ship it")).toBeInTheDocument();
    expect(within(timelineElement(container)).getByText("Sending")).toBeInTheDocument();
    const sendingButton = screen.getByRole("button", { name: /sending message/i });
    expect(sendingButton).toBeDisabled();
    expect(sendingButton).toHaveAttribute("data-action-state", "submitting");

    await act(async () => {
      turnStart.resolve({ disposition: "started", rawPayload: { turnId: "turn-2" } });
      await turnStart.promise;
    });
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /sending message/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /send message/i })).toBeDisabled();
    expect(within(timelineElement(container)).queryByText("Ship it")).not.toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Sending")).not.toBeInTheDocument();

    let selectedThreadStream: FakeEventSource | undefined;
    await waitFor(() => {
      selectedThreadStream = latestFakeEventSource(
        (instance) => hasThreadId(instance, "thread-1") && !instance.closed,
      );
      expect(selectedThreadStream).toBeDefined();
      expect(selectedThreadStream?.onmessage).toBeTypeOf("function");
    });
    act(() => {
      selectedThreadStream?.emitNamed("thread_view.patch", projectionPatchEvent({
        id: "projection-sent-user",
        seq: 3,
        threadId: thread.id,
        turnId: "turn-2",
        itemId: "sent-user-2",
        itemType: "userMessage",
        text: "Ship it",
        displayOrder: 3,
        status: "running",
      }));
    });
    await waitFor(() => expect(within(timelineElement(container)).getAllByText("Ship it")).toHaveLength(1));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /sending message/i })).not.toBeInTheDocument();
    });
  });

  it("starts thread compaction from the /compact command without sending model input", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/compact": { disposition: "started", rawPayload: {} },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "/compact");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/compact")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);
    expect(composer).toHaveValue("");
  });

  it("rejects /compact with attachments without clearing the draft or uploading files", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:compact-attachment");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/uploads/images": {
          images: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" }],
        },
        "POST /v1/threads/thread-1/compact": { disposition: "started", rawPayload: {} },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    await userEvent.upload(input!, new File(["fake"], "diagram.png", { type: "image/png" }));
    expect(createObjectUrl).toHaveBeenCalled();
    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "/compact");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText(/\/compact does not support attachments/i)).toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(0);
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/compact")).toHaveLength(0);
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);
    expect(composer).toHaveValue("/compact");
    expect(screen.getByRole("button", { name: /remove diagram\.png/i })).toBeInTheDocument();
  });

  it("rejects unknown first-token slash commands without sending model input", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "/nope please");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(await screen.findByText(/unknown command: \/nope please/i)).toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/compact")).toHaveLength(0);
    expect(composer).toHaveValue("/nope please");
  });

  it("sends slash text in ordinary prompt content as model input", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Please run /compact later");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/compact")).toHaveLength(0);
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0])).resolves.toEqual({
      input: [{ type: "text", text: "Please run /compact later" }],
    });
  });

  it("treats accepted pending user projection as active before app-server materializes the turn", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": { payload: { turnId: "turn-1" } },
        "POST /v1/threads/thread-1/interrupt-current": {
          disposition: "interrupted",
          interruptedTurnId: "turn-1",
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "Start pending turn");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
    let selectedThreadStream: FakeEventSource | undefined;
    await waitFor(() => {
      selectedThreadStream = latestFakeEventSource(
        (instance) => hasThreadId(instance, "thread-1") && !instance.closed,
      );
      expect(selectedThreadStream).toBeDefined();
      expect(selectedThreadStream?.onmessage).toBeTypeOf("function");
    });

    act(() => {
      selectedThreadStream?.emitNamed("thread_view.patch", projectionPatchEvent({
        id: "pending-user-projection",
        seq: 2,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "pending-user-2",
        itemType: "userMessage",
        text: "Start pending turn",
        displayOrder: 2,
        status: "running",
      }));
    });

    expect(await screen.findByText("Start pending turn")).toBeInTheDocument();
    const stopButton = await screen.findByRole("button", { name: /stop turn/i });
    await userEvent.click(stopButton);
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/interrupt-current")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns/turn-1/interrupt")).toHaveLength(0);
  });

  it("keeps unsent composer text scoped to the selected thread", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.type(composerInThreadPane(/implement frontend/i), "Draft for first thread");

    await userEvent.click(within(workspaceNavigation()).getByRole("button", { name: /second thread/i }));
    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();
    expect(composerInThreadPane(/second thread/i)).toHaveValue("");

    await userEvent.type(composerInThreadPane(/second thread/i), "Draft for second thread");
    await userEvent.click(screen.getByRole("button", { name: /implement frontend/i }));
    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    expect(composerInThreadPane(/implement frontend/i)).toHaveValue("Draft for first thread");

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();
    expect(composerInThreadPane(/second thread/i)).toHaveValue("Draft for second thread");
  }, 20_000);

  it("sends selected skill metadata and renders the skill row only from gateway patches", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const turnStart = deferred<unknown>();
    mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "GET /v1/skills": {
          cwd: "/home/example/kodex",
          skills: [
            {
              name: "documents:documents",
              path: "/skills/documents/SKILL.md",
              description: "Create and edit documents",
              enabled: true,
              scope: "user",
              shortDescription: null,
              interface: {
                displayName: "Documents",
                shortDescription: "Create and edit document files",
                brandColor: "#2563EB",
                defaultPrompt: null,
                iconSmall: "/skills/documents/assets/file-document.png",
                iconLarge: null,
              },
            },
          ],
          errors: [],
          invalidationGeneration: 0,
        },
        "POST /v1/threads/thread-1/input": () => turnStart.promise,
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "$doc");
    expect(await screen.findByRole("option", { name: /documents/i })).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
    });
    expect(container.querySelector(".kodex-inline-skill-badge")).toHaveTextContent("Documents");
    const selectedThreadStream = FakeEventSource.instances.find((instance) => hasThreadId(instance, "thread-1"));
    expect(selectedThreadStream).toBeDefined();
    act(() => {
      selectedThreadStream?.emit(projectionPatchEvent({
        id: "projection-skill-user",
        seq: 3,
        threadId: thread.id,
        turnId: "turn-2",
        itemId: "user-skill-1",
        itemType: "userMessage",
        text: "$documents",
        displayOrder: 3,
        status: "completed",
        skillMentions: [
          {
            start: 0,
            end: "$documents".length,
            name: "documents",
            path: "/skills/documents/SKILL.md",
            displayName: "Documents",
            shortDescription: "Create and edit document files",
            brandColor: "#2563EB",
            iconSmallUrl: "/skills/documents/assets/file-document.png",
          },
        ],
      }));
    });

    await waitFor(() => {
      const badge = container.querySelector(".kodex-inline-skill-badge");
      expect(badge).toHaveTextContent("Documents");
      expect(badge).toHaveAttribute("data-has-accent", "true");
      expect(badge).toHaveStyle({ "--skill-accent-color": "#2563EB" });
      expect(badge).toHaveStyle({ "--skill-accent-foreground": "#ffffff" });
      expect(badge?.querySelector(".kodex-inline-skill-icon")).toBeInTheDocument();
    });

    turnStart.resolve({ payload: {} });
  });

  it("queues active-turn composer messages through the gateway queue", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      }),
    );

    render(<App />);

    await expectHelloFromCodex();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Steered follow-up");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/queued-inputs")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);
    expect(screen.getByRole("region", { name: /queued steer messages/i })).toHaveTextContent("Steered follow-up");
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/queued-inputs")[0])).resolves.toMatchObject({
      input: [{ type: "text", text: "Steered follow-up" }],
    });
  });

  it("applies queued input SSE upserts and deletes without adding timeline rows", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      }),
    );

    render(<App />);

    await expectHelloFromCodex();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const selectedThreadStream = FakeEventSource.instances.find((instance) => hasThreadId(instance, "thread-1"));
    expect(selectedThreadStream).toBeDefined();

    act(() => {
      selectedThreadStream?.emitNamed("turn_queue.item_upsert", {
        id: "event-queued-upsert",
        seq: 2,
        kind: "turn_queue.item_upsert",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: null,
        itemId: null,
        payload: {
          id: "queue-sse-1",
          threadId: thread.id,
          input: [{ type: "text", text: "From SSE" }],
          options: {},
          status: "failed",
          priority: "normal",
          attemptCount: 1,
          lastError: "turn failed",
          createdAt: "2026-05-05T00:00:00Z",
          updatedAt: "2026-05-05T00:00:01Z",
        },
        receivedAt: "2026-05-05T00:00:02Z",
      });
    });

    expect(await screen.findByText("From SSE")).toBeInTheDocument();
    expect(screen.getByText("turn failed")).toBeInTheDocument();
    expect(screen.queryAllByText("From SSE")).toHaveLength(1);

    act(() => {
      selectedThreadStream?.emitNamed("turn_queue.item_deleted", {
        id: "event-queued-delete",
        seq: 3,
        kind: "turn_queue.item_deleted",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: null,
        itemId: null,
        payload: { id: "queue-sse-1", threadId: thread.id },
        receivedAt: "2026-05-05T00:00:03Z",
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("From SSE")).not.toBeInTheDocument();
    });
  });

  it("does not let a stale queued-input list overwrite newer queue events", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveQueuedInputs!: (body: unknown) => void;
    const queuedInputsResponse = new Promise((resolve) => {
      resolveQueuedInputs = resolve;
    });
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-1/queued-inputs": () => queuedInputsResponse,
      }),
    );

    render(<App />);

    await expectHelloFromCodex();
    await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads/thread-1/queued-inputs")).toHaveLength(1));
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const selectedThreadStream = FakeEventSource.instances.find((instance) => hasThreadId(instance, "thread-1"));
    expect(selectedThreadStream).toBeDefined();

    act(() => {
      selectedThreadStream?.emitNamed("turn_queue.item_upsert", {
        id: "event-queued-delete-me-upsert",
        seq: 2,
        kind: "turn_queue.item_upsert",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: null,
        itemId: null,
        payload: {
          id: "queue-deleted",
          threadId: thread.id,
          input: [{ type: "text", text: "Deleted by SSE" }],
          options: {},
          status: "queued",
          priority: "normal",
          attemptCount: 0,
          lastError: null,
          createdAt: "2026-05-05T00:00:00Z",
          updatedAt: "2026-05-05T00:00:00Z",
        },
        receivedAt: "2026-05-05T00:00:01Z",
      });
      selectedThreadStream?.emitNamed("turn_queue.item_deleted", {
        id: "event-queued-delete-me-delete",
        seq: 3,
        kind: "turn_queue.item_deleted",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: null,
        itemId: null,
        payload: { id: "queue-deleted", threadId: thread.id },
        receivedAt: "2026-05-05T00:00:02Z",
      });
      selectedThreadStream?.emitNamed("turn_queue.item_upsert", {
        id: "event-queued-newer-upsert",
        seq: 4,
        kind: "turn_queue.item_upsert",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: null,
        itemId: null,
        payload: {
          id: "queue-newer",
          threadId: thread.id,
          input: [{ type: "text", text: "Newer from SSE" }],
          options: {},
          status: "queued",
          priority: "normal",
          attemptCount: 0,
          lastError: null,
          createdAt: "2026-05-05T00:00:03Z",
          updatedAt: "2026-05-05T00:00:03Z",
        },
        receivedAt: "2026-05-05T00:00:04Z",
      });
    });

    expect(await screen.findByText("Newer from SSE")).toBeInTheDocument();
    expect(screen.queryByText("Deleted by SSE")).not.toBeInTheDocument();

    await act(async () => {
      resolveQueuedInputs({
        queuedInputs: [
          {
            id: "queue-deleted",
            threadId: "thread-1",
            input: [{ type: "text", text: "Deleted by SSE" }],
            options: {},
            status: "queued",
            priority: "normal",
            attemptCount: 0,
            lastError: null,
            createdAt: "2026-05-05T00:00:00Z",
            updatedAt: "2026-05-05T00:00:00Z",
          },
        ],
      });
      await queuedInputsResponse;
    });

    expect(screen.getByText("Newer from SSE")).toBeInTheDocument();
    expect(screen.queryByText("Deleted by SSE")).not.toBeInTheDocument();
  });

  it("loads queued inputs for the selected thread and retries failed rows", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-1/queued-inputs": {
          queuedInputs: [
            {
              id: "queue-failed",
              threadId: "thread-1",
              input: [{ type: "text", text: "Retry later" }],
              options: {},
              status: "failed",
              priority: "normal",
              attemptCount: 1,
              lastError: "turn failed",
              createdAt: "2026-05-05T00:00:00Z",
              updatedAt: "2026-05-05T00:00:01Z",
            },
          ],
        },
      }),
    );

    render(<App />);

    expect(await screen.findByText("Retry later")).toBeInTheDocument();
    expect(screen.getByText("turn failed")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/queued-inputs/queue-failed/retry")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);
  });

  it("steers queued composer messages into the active turn when requested", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "POST /v1/threads/thread-1/input": (request: Request) => queuedThreadInputResponse(request, "queue-1"),
      }),
    );

    render(<App />);

    await expectHelloFromCodex();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Steer this turn");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    await userEvent.click(screen.getByRole("button", { name: /^steer$/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/queued-inputs/queue-1/steer")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/queued-inputs")).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByRole("region", { name: /queued steer messages/i })).toHaveTextContent("Steering...");
    });
  });

  it("renders sent text optimistically before the gateway projection patch", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveTurn: (value: unknown) => void = () => undefined;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": () =>
          new Promise((resolve) => {
            resolveTurn = resolve;
          }),
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Ship it");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
    });
    expect(await screen.findByText("Ship it")).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    const selectedThreadStream = FakeEventSource.instances.find((instance) => hasThreadId(instance, "thread-1"));
    act(() => {
      selectedThreadStream?.emit(projectionPatchEvent({
        id: "projection-sent-text",
        seq: 3,
        threadId: thread.id,
        turnId: "turn-2",
        itemId: "user-2",
        itemType: "userMessage",
        text: "Ship it",
        displayOrder: 3,
        status: "completed",
      }));
    });
    await waitFor(() => expect(screen.getAllByText("Ship it")).toHaveLength(1));

    act(() => resolveTurn({ payload: {} }));
    await waitFor(() => expect(screen.getByLabelText(/message composer/i)).toBeEnabled());
  });

  it("keeps a background send in progress after switching threads and renders one materialized prompt", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveTurn: (value: unknown) => void = () => undefined;
    let firstThreadTurns: ReturnType<typeof snapshotTurn>[] = [];
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-1": () => {
          const detail = threadDetail(thread, firstThreadTurns);
          return firstThreadTurns.length === 0
            ? detail
            : { ...detail, timeline: { ...detail.timeline, viewRevision: 3 } };
        },
        "GET /v1/threads/thread-2": threadDetail(secondThread, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Second thread snapshot" })]),
        ]),
        "POST /v1/threads/thread-1/input": () =>
          new Promise((resolve) => {
            resolveTurn = resolve;
          }),
      }),
    );
    setInitialWorkspacePaneState({
      activePaneId: "pane-thread-1",
      dockviewLayout: null,
      panes: [
        {
          id: "pane-thread-1",
          kind: "thread",
          target: { mode: "existing", threadId: "thread-1" },
          title: "Implement frontend",
        },
        {
          id: "pane-thread-2",
          kind: "thread",
          target: { mode: "existing", threadId: "thread-2" },
          title: "Second thread",
        },
      ],
      schemaVersion: 1,
    });

    const { container } = render(<App />);

    const firstThreadButton = await within(workspaceNavigation()).findByRole("button", { name: /implement frontend/i });
    const firstThreadRow = firstThreadButton.closest(".kodex-thread-list-button");
    expect(firstThreadRow).toBeInTheDocument();
    await userEvent.type(composerInThreadPane(/implement frontend/i), "sleep 5s, then send hello");
    await userEvent.click(sendButtonInThreadPane(/implement frontend/i));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
      expect(firstThreadRow?.querySelector(".kodex-thread-progress-indicator")).toBeInTheDocument();
    });

    await userEvent.click(within(workspaceNavigation()).getByRole("button", { name: /second thread/i }));
    expect(await screen.findByText(/second thread snapshot/i)).toBeInTheDocument();
    const currentFirstThreadRow = within(workspaceNavigation())
      .getByRole("button", { name: /implement frontend/i })
      .closest(".kodex-thread-list-button");
    expect(currentFirstThreadRow?.querySelector(".kodex-thread-progress-indicator")).toBeInTheDocument();

    firstThreadTurns = [
      snapshotTurn("turn-3", [
        snapshotItem("user-3", "userMessage", {
          content: [{ type: "text", text: "sleep 5s, then send hello" }],
        }),
        snapshotItem("agent-3", "agentMessage", { text: "hello" }),
      ]),
    ];
    act(() => resolveTurn({ payload: {} }));
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalStream = latestFakeEventSource((instance) => hasThreadId(instance, "thread-1") && !instance.closed);
    act(() => {
      globalStream?.emit({
        id: "event-background-send-completed",
        seq: 3,
        kind: "thread_view.patch",
        codexMethod: "thread_view/patch",
        projectId: project.id,
        threadId: thread.id,
        turnId: null,
        itemId: null,
        payload: { scope: "lifecycle", viewRevision: 3, threadId: thread.id, activeTurnId: null, liveState: "idle" },
        receivedAt: "2026-05-02T00:00:02Z",
      });
      globalStream?.emit({
        id: "event-background-send-read-state",
        seq: 4,
        kind: "thread.read_updated",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: null,
        itemId: null,
        payload: {
          threadId: thread.id,
          seenCompletedAgentTurnSeq: 0,
          lastCompletedAgentTurnSeq: null,
          unreadCompletedAgentTurn: true,
        },
        receivedAt: "2026-05-02T00:00:03Z",
      });
    });

    await waitFor(() => {
      const currentFirstThreadRow = within(workspaceNavigation())
        .getByRole("button", { name: /implement frontend/i })
        .closest(".kodex-thread-list-button");
      expect(currentFirstThreadRow?.querySelector(".kodex-thread-progress-indicator")).not.toBeInTheDocument();
      expect(currentFirstThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).toBeInTheDocument();
    });

    await userEvent.click(within(workspaceNavigation()).getByRole("button", { name: /implement frontend/i }));
    expect(await screen.findByText("hello")).toBeInTheDocument();
    expect(within(timelineElement(container)).getAllByText("sleep 5s, then send hello")).toHaveLength(1);
  });

  it("removes failed optimistic text sends before retrying from the restored composer", async () => {
    let turnAttempts = 0;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": () => {
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
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
    expect(await screen.findByText(/gateway request failed|start turn failed/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Retry text");
    expect(within(timelineElement(container)).queryByText("Retry text")).not.toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Failed")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(2);
      expect(screen.queryByText("Sending")).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
    expect(within(timelineElement(container)).queryByText("Retry text")).not.toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Failed")).not.toBeInTheDocument();
  });

  it("keeps composer editing disabled during a pending text send and restores retry text on failure", async () => {
    let rejectTurn: (reason?: unknown) => void = () => undefined;
    mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": () =>
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
        "POST /v1/threads/thread-1/input": () =>
          new Promise((_resolve, reject) => {
            rejectTurn = reject;
          }),
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Retry in first thread");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(screen.getByLabelText(/message composer/i)).toHaveValue(""));

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();

    await act(async () => {
      rejectTurn(new Error("start turn failed"));
    });

    expect(await screen.findByText(/gateway request failed|start turn failed/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
    expect(within(timelineElement(container)).queryByText("Retry in first thread")).not.toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(0);
  });

  it("attaches image files, uploads them on send, and posts local image inputs", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/uploads/images": { images: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" }] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    const file = new File(["fake"], "diagram.png", { type: "image/png" });
    await userEvent.upload(input!, file);

    expect(await screen.findByRole("button", { name: /remove diagram.png/i })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Inspect this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0])).resolves.toEqual({
      input: [
        { type: "text", text: "Inspect this" },
        { type: "localImage", path: "/tmp/diagram.png" },
      ],
    });
  });

  it("attaches file uploads and posts attachment metadata without local image inputs", async () => {
    const fileAttachment = {
      id: "file-upload-1",
      fileName: "notes.md",
      extension: "md",
      relativePath: ".kodex/uploads/thread-1/file-upload-1/notes.md",
      absolutePath: "/workspace/.kodex/uploads/thread-1/file-upload-1/notes.md",
      mimeType: "text/markdown",
      sizeBytes: 7,
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/uploads/files": { files: [fileAttachment] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();

    await userEvent.upload(input!, new File(["# notes"], "notes.md", { type: "text/markdown" }));

    expect(screen.getByRole("button", { name: /remove notes.md/i })).toBeInTheDocument();
    expect(screen.getByText("MD")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "Review this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/uploads/files")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
    expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(0);
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[0])).resolves.toEqual({
      input: [{ type: "text", text: "Review this" }],
      attachments: [fileAttachment],
    });
  });

  it("keeps image sends local while upload is pending", async () => {
    let resolveUpload: (value: unknown) => void = () => undefined;
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pending-diagram");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/uploads/images": () =>
          new Promise((resolve) => {
            resolveUpload = resolve;
          }),
        "POST /v1/threads/thread-1/input": { payload: {} },
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

    await waitFor(() => expect(screen.getByLabelText(/message composer/i)).toHaveValue(""));
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
    expect(input).toBeDisabled();
    fireEvent.change(input!, {
      target: { files: [new File(["fake"], "second-diagram.png", { type: "image/png" })] },
    });
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /remove second-diagram.png/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);

    act(() =>
      resolveUpload({
        images: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" }],
      }),
    );
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    });
  });

  it("keeps draft thread image sends local before upload resolves", async () => {
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
        "POST /v1/threads/thread-2/input": { payload: {} },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    expect(within(screen.getByRole("main", { name: /thread/i })).queryByRole("heading", { name: /new thread/i })).not.toBeInTheDocument();

    await userEvent.upload(attachmentInputInActiveThreadPane(), new File(["fake"], "diagram.png", { type: "image/png" }));
    expect(createObjectUrl).toHaveBeenCalled();

    await userEvent.type(composerInActiveThreadPane(), "Inspect this");
    await userEvent.click(sendButtonInActiveThreadPane());

    await waitFor(() => expect(composerInActiveThreadPane()).toHaveValue(""));
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(0);
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:draft-diagram");

    act(() =>
      resolveUpload({
        images: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" }],
      }),
    );
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    });
  });

  it("waits to load a new draft thread snapshot until the first turn materializes it", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let materialized = false;
    let resolveTurn: (value: unknown) => void = () => undefined;
    const draftThread = { ...thread, id: "thread-2", name: "New thread", preview: null };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads": { thread: draftThread, rawPayload: {} },
        "POST /v1/threads/thread-2/input": () =>
          new Promise((resolve) => {
            resolveTurn = (value) => {
              materialized = true;
              resolve(value);
            };
          }),
        "GET /v1/threads/thread-2": () => {
          if (!materialized) {
            throw new Error('APP-SERVER ERROR -32600 "thread thread-2 is not materialized yet"');
          }
          return threadDetail(
            { ...draftThread, preview: "Materialize this" },
            [
              snapshotTurn("turn-1", [
                snapshotItem("user-1", "userMessage", {
                  content: [{ type: "text", text: "Materialize this" }],
                }),
                snapshotItem("agent-1", "agentMessage", { text: "Materialized response" }),
              ]),
            ],
          );
        },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    await userEvent.type(composerInActiveThreadPane(), "Materialize this");
    await userEvent.click(sendButtonInActiveThreadPane());

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(1);
    });
    expect(gateway.callsFor("GET", "/v1/threads/thread-2")).toHaveLength(0);
    expect(screen.queryByText(/not materialized yet/i)).not.toBeInTheDocument();

    act(() => resolveTurn({ payload: {} }));

    expect(await screen.findByText("Materialized response")).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-2")).toHaveLength(1);
    expect(within(timelineElement(container)).getAllByText("Materialize this")).toHaveLength(1);
  });

  it("retries transient draft thread snapshot reads after the first turn starts", async () => {
    let detailReads = 0;
    const draftThread = { ...thread, id: "thread-2", name: "New thread", preview: null };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads": { thread: draftThread, rawPayload: {} },
        "POST /v1/threads/thread-2/input": { payload: {} },
        "GET /v1/threads/thread-2": () => {
          detailReads += 1;
          if (detailReads === 1) {
            throw new Error('APP-SERVER ERROR -32600 "thread thread-2 is not materialized yet"');
          }
          return threadDetail(
            { ...draftThread, preview: "Materialize this" },
            [
              snapshotTurn("turn-1", [
                snapshotItem("user-1", "userMessage", {
                  content: [{ type: "text", text: "Materialize this" }],
                }),
                snapshotItem("agent-1", "agentMessage", { text: "Materialized response" }),
              ]),
            ],
          );
        },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    await userEvent.type(composerInActiveThreadPane(), "Materialize this");
    await userEvent.click(sendButtonInActiveThreadPane());

    expect(await screen.findByText("Materialized response")).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-2")).toHaveLength(2);
    expect(screen.queryByText(/not materialized yet/i)).not.toBeInTheDocument();
    expect(within(timelineElement(container)).getAllByText("Materialize this")).toHaveLength(1);
  });

  it("retries thread history load failures after a draft thread first turn starts", async () => {
    let detailReads = 0;
    const draftThread = { ...thread, id: "thread-2", name: "New thread", preview: null };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads": { thread: draftThread, rawPayload: {} },
        "POST /v1/threads/thread-2/input": { payload: {} },
        "GET /v1/threads/thread-2": () => {
          detailReads += 1;
          if (detailReads === 1) {
            throw new Error('APP-SERVER ERROR -32603 "FAILED TO LOAD THREAD HISTORY"');
          }
          return threadDetail(
            { ...draftThread, preview: "Materialize this" },
            [
              snapshotTurn("turn-1", [
                snapshotItem("user-1", "userMessage", {
                  content: [{ type: "text", text: "Materialize this" }],
                }),
                snapshotItem("agent-1", "agentMessage", { text: "Materialized response" }),
              ]),
            ],
          );
        },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    await userEvent.type(composerInActiveThreadPane(), "Materialize this");
    await userEvent.click(sendButtonInActiveThreadPane());

    expect(await screen.findByText("Materialized response")).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-2")).toHaveLength(2);
    expect(screen.queryByText(/failed to load thread history/i)).not.toBeInTheDocument();
    expect(within(timelineElement(container)).getAllByText("Materialize this")).toHaveLength(1);
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
        "POST /v1/threads/thread-2/input": { payload: {} },
        "GET /v1/threads/thread-2": threadDetail(
          { ...thread, id: "thread-2", name: "New thread", preview: "Inspect this" },
          [
            snapshotTurn("turn-1", [
              snapshotItem("user-1", "userMessage", {
                content: [{ type: "text", text: "Inspect this" }],
              }),
            ]),
          ],
        ),
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /new thread/i }));
    await userEvent.upload(attachmentInputInActiveThreadPane(), new File(["fake"], "diagram.png", { type: "image/png" }));
    expect(createObjectUrl).toHaveBeenCalled();

    await userEvent.type(composerInActiveThreadPane(), "Inspect this");
    await userEvent.click(sendButtonInActiveThreadPane());

    await waitFor(() => expect(composerInActiveThreadPane()).toHaveValue(""));
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(0);
    expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(1);
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:draft-retry-diagram");

    rejectUpload(new Error("Upload unavailable"));
    await Promise.resolve();

    expect(await screen.findByText("Failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove diagram.png/i })).toBeInTheDocument();
    expect(screen.getByText("Upload unavailable")).toBeInTheDocument();
    expect(composerInActiveThreadPane()).toHaveValue("Inspect this");
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:draft-retry-diagram");

    expect(sendButtonInActiveThreadPane()).toBeEnabled();
    fireEvent.click(sendButtonInActiveThreadPane());

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(2);
      expect(gateway.callsFor("POST", "/v1/threads")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(1);
    }, { timeout: 2_000 });
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
        "POST /v1/threads/thread-1/input": { payload: {} },
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
    await waitFor(() => expect(screen.getByLabelText(/message composer/i)).toHaveValue(""));

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(await screen.findByRole("heading", { name: /second thread/i })).toBeInTheDocument();

    await act(async () => {
      rejectUpload(new Error("Upload unavailable"));
    });

    expect(await screen.findByText("Upload unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("");
    expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/input")).toHaveLength(0);
  });

  it("removes failed optimistic image sends after upload before retrying the turn start", async () => {
    let turnAttempts = 0;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/uploads/images": {
          images: [{ id: "upload-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 4, path: "/tmp/diagram.png" }],
        },
        "POST /v1/threads/thread-1/input": () => {
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
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
    expect(await screen.findByText(/gateway request failed|start turn failed/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toHaveValue("Inspect this");
    expect(screen.getByRole("button", { name: /remove diagram.png/i })).toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
    expect(within(timelineElement(container)).queryByText("Failed")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/uploads/images")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(2);
      expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/input")[1])).resolves.toEqual({
      input: [
        { type: "text", text: "Inspect this" },
        { type: "localImage", path: "/tmp/diagram.png" },
      ],
    });
    expect(within(timelineElement(container)).queryByText("Inspect this")).not.toBeInTheDocument();
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
        "POST /v1/threads/thread-1/input": { payload: {} },
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
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /remove diagram.png/i })).not.toBeInTheDocument();
    });
    expect(revokeObjectUrl).not.toHaveBeenCalledWith("blob:diagram-preview");

    let selectedThreadStream: FakeEventSource | undefined;
    await waitFor(() => {
      selectedThreadStream = FakeEventSource.instances.find((instance) => hasThreadId(instance, "thread-1"));
      expect(selectedThreadStream).toBeDefined();
    });
    act(() => {
      selectedThreadStream?.emit(projectionPatchEvent({
        id: "event-user-image",
        seq: 2,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "user-image-1",
        itemType: "userMessage",
        text: "Inspect this",
        displayOrder: 2,
        status: "completed",
        imagePath: "/tmp/diagram.png",
      }));
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

  it("attaches pasted image files from the message composer", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pasted-preview");
    const file = new File(["fake"], "pasted.png", { type: "image/png" });
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: {
        files: [],
        items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      },
    });

    fireEvent(composer, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole("button", { name: /remove pasted.png/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /open pasted.png/i }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector(".kodex-image-lightbox-img")).toHaveAttribute("src", "blob:pasted-preview");

    await userEvent.click(screen.getByRole("button", { name: /close image preview/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("queues active-turn composer text, steers selected rows, and removes only successful rows", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let queuedInputIndex = 0;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/events": (request: Request) => {
          const url = new URL(request.url);
          return url.searchParams.get("threadId") === "thread-2" ? { events: [] } : baseRoutes()["GET /v1/events"];
        },
        "POST /v1/threads/thread-1/input": (request: Request) => {
          queuedInputIndex += 1;
          return queuedThreadInputResponse(request, `queue-${queuedInputIndex}`);
        },
      }),
    );

    render(<App />);

    await expectHelloFromCodex();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
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
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/queued-inputs/queue-1/steer")).toHaveLength(1);
      expect(within(screen.getByRole("region", { name: /queued steer messages/i })).getByText("Add tests")).toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: /queued steer messages/i })).getByText("Steering...")).toBeInTheDocument();
    });
    act(() => {
      for (const source of FakeEventSource.instances) {
        const event = {
          seq: 10_000,
          id: "queue-delete-1",
          receivedAt: "2026-05-05T00:00:02Z",
          kind: "turn_queue.item_deleted",
          threadId: "thread-1",
          payload: { id: "queue-1", threadId: "thread-1" },
        };
        source.emit(event);
        source.emitNamed("turn_queue.item_deleted", event);
      }
    });
    await waitFor(() => {
      expect(within(screen.getByRole("region", { name: /queued steer messages/i })).queryByText("Add tests")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Keep scope tight")).toBeInTheDocument();

    await userEvent.click(
      within(screen.getByRole("region", { name: /queued steer messages/i })).getByRole("button", {
        name: /abort queued message/i,
      }),
    );
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: /queued steer messages/i })).not.toBeInTheDocument();
    });
    expect(gateway.callsFor("DELETE", "/v1/threads/thread-1/queued-inputs/queue-2")).toHaveLength(1);

    await userEvent.type(composer, "Switch clear{Enter}");
    expect(screen.getByText("Switch clear")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: /queued steer messages/i })).not.toBeInTheDocument();
    });
  });

  it("keeps failed queued steer rows retryable and reports the existing error", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [activeThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-1/queued-inputs": {
          queuedInputs: [
            {
              id: "queue-failed",
              threadId: "thread-1",
              input: [{ type: "text", text: "Retry this" }],
              options: {},
              status: "failed",
              priority: "normal",
              attemptCount: 1,
              lastError: "steer failed",
              createdAt: "2026-05-05T00:00:00Z",
              updatedAt: "2026-05-05T00:00:01Z",
            },
          ],
        },
      }),
    );

    render(<App />);

    await expectHelloFromCodex();
    const queuedCard = screen.getByRole("region", { name: /queued steer messages/i });
    const row = within(queuedCard).getByRole("group");
    const rowId = row.getAttribute("data-steer-row-id");

    expect(screen.getByText("steer failed")).toBeInTheDocument();
    expect(screen.getByText("Retry this")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: /queued steer messages/i })).getByRole("group")).toHaveAttribute(
      "data-steer-row-id",
      rowId,
    );

    await userEvent.click(within(screen.getByRole("region", { name: /queued steer messages/i })).getByRole("button", { name: /retry/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/queued-inputs/queue-failed/retry")).toHaveLength(1);
      expect(screen.getByText("Retry later")).toBeInTheDocument();
    });
  });

  it("submits on Enter and keeps Shift+Enter as a newline in the main composer", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "Line one");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    await userEvent.type(composer, "Line two");

    expect(composer).toHaveValue("Line one\nLine two");
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);

    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
  });

  it("submits on Enter in a narrow non-touch composer", async () => {
    vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
      matches: query.includes("max-width") ? true : false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "Narrow hardware keyboard");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
  });

  it("keeps Enter as a newline on touch input and requires the send action to submit", async () => {
    vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
      matches: query.includes("max-width") || query === "(any-pointer: coarse)" || query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/message composer/i));
    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "Line one");
    await userEvent.keyboard("{Enter}");
    await userEvent.type(composer, "Line two");

    expect(composer).toHaveValue("Line one\nLine two");
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
  });

  it("submits on Cmd+Enter on touch input with a hardware keyboard", async () => {
    vi.stubGlobal("matchMedia", (query: string): MediaQueryList => ({
      matches: query.includes("max-width") || query === "(any-pointer: coarse)" || query === "(pointer: coarse)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads/thread-1/input": { payload: {} },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const composer = screen.getByLabelText(/message composer/i);
    await userEvent.type(composer, "Hardware keyboard submit");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/input")).toHaveLength(1);
    });
  });

});
