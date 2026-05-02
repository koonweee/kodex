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

describe("MVP timeline flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
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

  it("marks completed unread agent turns in the thread list and clears them when seen", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-2/seen": {
          threadId: "thread-2",
          seenCompletedAgentTurnSeq: 3,
          updatedAt: "2026-04-30T00:00:02Z",
        },
      }),
    );

    render(<App />);

    const firstThreadButton = await screen.findByRole("button", { name: /implement frontend/i });
    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    const firstThreadRow = firstThreadButton.closest(".kodex-thread-list-button");
    const secondThreadRow = secondThreadButton.closest(".kodex-thread-list-button");
    expect(firstThreadRow).toBeInTheDocument();
    expect(secondThreadRow).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalStream).toBeDefined();

    act(() => {
      globalStream?.emit({
        id: "event-other-thread-delta",
        seq: 2,
        kind: "codex",
        codexMethod: "item/agentMessage/delta",
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "answer-2",
        payload: { delta: "Still streaming" },
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });
    expect(secondThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).not.toBeInTheDocument();

    act(() => {
      globalStream?.emit({
        id: "event-other-thread-completed",
        seq: 3,
        kind: "codex",
        codexMethod: "turn/completed",
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: null,
        payload: { threadId: "thread-2", turn: { id: "turn-2" } },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });
    expect(secondThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).toBeInTheDocument();
    expect(firstThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).not.toBeInTheDocument();

    await userEvent.click(secondThreadButton);
    await waitFor(() => {
      expect(secondThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).not.toBeInTheDocument();
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-2/seen")).toHaveLength(1);
  });

  it("does not mark already represented completed turns unread when the global stream replays after refresh", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [
            thread,
            {
              ...secondThread,
              lastCompletedAgentTurnSeq: 3,
              seenCompletedAgentTurnSeq: 3,
              unreadCompletedAgentTurn: false,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );

    render(<App />);

    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalStream).toBeDefined();

    act(() => {
      globalStream?.emit({
        id: "event-replayed-completed",
        seq: 3,
        kind: "codex",
        codexMethod: "turn/completed",
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: null,
        payload: { threadId: "thread-2", turn: { id: "turn-2" } },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(secondThreadButton.querySelector(".kodex-thread-unread-agent-turn-indicator")).not.toBeInTheDocument();
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

});
