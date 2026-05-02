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

describe("MVP composer input flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
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
    await clickMenuItem(/add attachment/i);
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

  it("keeps a background send in progress after switching threads and renders one materialized prompt", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveTurn: (value: unknown) => void = () => undefined;
    let firstThreadTurns: ReturnType<typeof snapshotTurn>[] = [];
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
        "GET /v1/threads/thread-1": () => threadDetail(thread, firstThreadTurns),
        "GET /v1/threads/thread-2": threadDetail(secondThread, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Second thread snapshot" })]),
        ]),
        "POST /v1/threads/thread-1/turns": () =>
          new Promise((resolve) => {
            resolveTurn = resolve;
          }),
      }),
    );

    const { container } = render(<App />);

    const firstThreadButton = await screen.findByRole("button", { name: /implement frontend/i });
    const firstThreadRow = firstThreadButton.closest(".kodex-thread-list-button");
    expect(firstThreadRow).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/message composer/i), "sleep 5s, then send hello");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/turns")).toHaveLength(1);
      expect(firstThreadRow?.querySelector(".kodex-thread-progress-indicator")).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(await screen.findByText(/second thread snapshot/i)).toBeInTheDocument();
    expect(firstThreadRow?.querySelector(".kodex-thread-progress-indicator")).toBeInTheDocument();

    firstThreadTurns = [
      snapshotTurn("turn-3", [
        snapshotItem("user-3", "userMessage", {
          content: [{ type: "text", text: "sleep 5s, then send hello" }],
        }),
        snapshotItem("agent-3", "agentMessage", { text: "hello" }),
      ]),
    ];
    act(() => resolveTurn({ payload: {} }));
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    act(() => {
      globalStream?.emit({
        id: "event-background-send-completed",
        seq: 3,
        kind: "timeline.turn_upsert",
        codexMethod: "turn/upsert",
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-3",
        itemId: null,
        payload: { threadId: thread.id, turn: { id: "turn-3", status: "completed", items: [] } },
        receivedAt: "2026-05-02T00:00:02Z",
      });
    });

    expect(firstThreadRow?.querySelector(".kodex-thread-progress-indicator")).not.toBeInTheDocument();
    expect(firstThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).toBeInTheDocument();

    await userEvent.click(firstThreadButton);
    expect(await within(timelineElement(container)).findByText("hello")).toBeInTheDocument();
    expect(within(timelineElement(container)).getAllByText("sleep 5s, then send hello")).toHaveLength(1);
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

  it("waits to load a new draft thread snapshot until the first turn materializes it", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let materialized = false;
    let resolveTurn: (value: unknown) => void = () => undefined;
    const draftThread = { ...thread, id: "thread-2", name: "New thread", preview: null };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
        "POST /v1/threads": { thread: draftThread, rawPayload: {} },
        "POST /v1/threads/thread-2/turns": () =>
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
    await userEvent.type(screen.getByLabelText(/message composer/i), "Materialize this");
    await userEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-2/turns")).toHaveLength(1);
    });
    expect(gateway.callsFor("GET", "/v1/threads/thread-2")).toHaveLength(0);
    expect(screen.queryByText(/not materialized yet/i)).not.toBeInTheDocument();

    act(() => resolveTurn({ payload: {} }));

    expect(await within(timelineElement(container)).findByText("Materialized response")).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-2")).toHaveLength(1);
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
        "POST /v1/threads/thread-2/turns": { payload: {} },
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
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector(".kodex-image-lightbox-img")).toHaveAttribute("src", "blob:pasted-preview");

    await userEvent.click(screen.getByRole("button", { name: /close image preview/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

});
