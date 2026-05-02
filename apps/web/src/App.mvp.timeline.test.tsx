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

describe("MVP timeline flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("does not render a no-events placeholder in an empty selected thread", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/events": { events: [] },
      }),
    );

    const { container } = render(<App />);

    expect(await screen.findByRole("heading", { name: /implement frontend/i })).toBeInTheDocument();
    const timeline = timelineElement(container);
    expect(within(timeline).queryByText("No events")).not.toBeInTheDocument();
    expect(within(timeline).queryByText("Thread activity will stream into this timeline.")).not.toBeInTheDocument();
  });

  it("groups command and search activity into nested timeline collapsibles", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": threadDetail(thread, [
          snapshotTurn("turn-1", [
            snapshotItem("cmd-1", "commandExecution", {
              command: "pwd",
              cwd: "/home/example/kodex",
              output: "/home/example/kodex\n",
            }),
            snapshotItem("web-1", "webSearch", {
              action: { type: "search", query: "Codex renderer nested collapsibles" },
            }),
          ]),
        ]),
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
        kind: "timeline.turn_upsert",
        codexMethod: "turn/upsert",
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: null,
        payload: { threadId: "thread-2", turn: { id: "turn-2", status: "completed", items: [] } },
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

  it("transitions an in-progress thread indicator to unread when a background turn completes", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
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
    expect(runningThreadRow?.querySelector(".kodex-thread-progress-indicator")).toBeInTheDocument();
    expect(runningThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).not.toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalStream).toBeDefined();

    act(() => {
      globalStream?.emit({
        id: "event-running-thread-completed",
        seq: 3,
        kind: "timeline.turn_upsert",
        codexMethod: "turn/upsert",
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: null,
        payload: { threadId: "thread-2", turn: { id: "turn-2", status: "completed", items: [] } },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(runningThreadRow?.querySelector(".kodex-thread-progress-indicator")).not.toBeInTheDocument();
    expect(runningThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).toBeInTheDocument();
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

  it("advances background completion markers from persisted seen state when list markers are unknown", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [
            thread,
            {
              ...secondThread,
              lastCompletedAgentTurnSeq: null,
              seenCompletedAgentTurnSeq: 1,
              unreadCompletedAgentTurn: false,
            },
          ],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-2/seen": {
          threadId: "thread-2",
          seenCompletedAgentTurnSeq: 2,
          updatedAt: "2026-04-30T00:00:02Z",
        },
      }),
    );

    render(<App />);

    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    const secondThreadRow = secondThreadButton.closest(".kodex-thread-list-button");
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalStream).toBeDefined();

    act(() => {
      globalStream?.emit({
        id: "event-background-completed-after-reload",
        seq: 4,
        kind: "timeline.turn_upsert",
        codexMethod: "turn/upsert",
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: null,
        payload: { threadId: "thread-2", turn: { id: "turn-2", status: "completed", items: [] } },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(secondThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).toBeInTheDocument();

    await userEvent.click(secondThreadButton);
    await waitFor(() => {
      expect(secondThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).not.toBeInTheDocument();
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-2/seen")[0])).resolves.toEqual({
      seenCompletedAgentTurnSeq: 2,
    });
  });

  it("opens threads from snapshots without listEvents replay and ignores stale snapshot loads", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveFirstDetail: (value: unknown) => void = () => undefined;
    let resolveSecondDetail: (value: unknown) => void = () => undefined;
    const firstDetail = new Promise((resolve) => {
      resolveFirstDetail = resolve;
    });
    const secondDetail = new Promise((resolve) => {
      resolveSecondDetail = resolve;
    });
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/threads/thread-1": () => firstDetail,
        "GET /v1/threads/thread-2": () => secondDetail,
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    resolveSecondDetail(
      threadDetail(secondThread, [
        snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Second thread snapshot" })]),
      ]),
    );

    expect(await screen.findByText(/second thread snapshot/i)).toBeInTheDocument();
    resolveFirstDetail(
      threadDetail(thread, [
        snapshotTurn("turn-1", [snapshotItem("item-1", "agentMessage", { text: "Stale first snapshot" })]),
      ]),
    );

    await waitFor(() => {
      expect(screen.queryByText(/stale first snapshot/i)).not.toBeInTheDocument();
    });
    expect(gateway.callsFor("GET", "/v1/events")).toHaveLength(0);
    const threadStreams = FakeEventSource.instances.filter((instance) => instance.url.includes("threadId="));
    expect(threadStreams).toHaveLength(1);
    expect(threadStreams[0].url).toContain("threadId=thread-2");
  });

  it("refetches the selected snapshot when the stream requires snapshot recovery", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let detailCall = 0;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": () => {
          detailCall += 1;
          return threadDetail(thread, [
            snapshotTurn("turn-1", [
              snapshotItem("item-1", "agentMessage", {
                text: detailCall === 1 ? "Initial snapshot" : "Recovered snapshot",
              }),
            ]),
          ]);
        },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/initial snapshot/i)).toBeInTheDocument();
    const selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    expect(selectedThreadStream).toBeDefined();

    act(() => {
      selectedThreadStream?.emit({
        id: "snapshot-required-1",
        seq: 1,
        kind: "timeline.snapshot_required",
        codexMethod: "thread/snapshot_required",
        projectId: project.id,
        threadId: thread.id,
        turnId: null,
        itemId: null,
        payload: { threadId: thread.id, reason: "lagged" },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(await screen.findByText(/recovered snapshot/i)).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-1")).toHaveLength(2);
    expect(gateway.callsFor("GET", "/v1/events")).toHaveLength(0);
  });

  it("keeps a resumed idle external thread in send state after selected snapshot recovery", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let detailCall = 0;
    const externalThread = {
      ...secondThread,
      status: "notLoaded",
      source: "external",
      lastCompletedAgentTurnSeq: null,
      seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: false,
    };
    const resumedThread = {
      ...externalThread,
      status: "idle",
      lastCompletedAgentTurnSeq: 1,
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, externalThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "POST /v1/threads/thread-2/resume": { thread: resumedThread, rawPayload: {} },
        "GET /v1/threads/thread-2": () => {
          detailCall += 1;
          return threadDetail(resumedThread, [
            snapshotTurn("turn-2", [
              snapshotItem("agent-2", "agentMessage", {
                text: detailCall === 1 ? "External completed snapshot" : "External recovered snapshot",
              }),
            ]),
          ]);
        },
        "POST /v1/threads/thread-2/seen": {
          threadId: "thread-2",
          seenCompletedAgentTurnSeq: 1,
          updatedAt: "2026-04-30T00:00:02Z",
        },
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /second thread/i }));
    expect(await screen.findByText(/external completed snapshot/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stop turn/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.some((instance) => instance.url.includes("threadId=thread-2"))).toBe(true));
    const selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-2"));

    act(() => {
      selectedThreadStream?.emit({
        id: "snapshot-required-external",
        seq: 1,
        kind: "timeline.snapshot_required",
        codexMethod: "thread/snapshot_required",
        projectId: project.id,
        threadId: "thread-2",
        turnId: null,
        itemId: null,
        payload: { threadId: "thread-2", reason: "thread_changed" },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(await screen.findByText(/external recovered snapshot/i)).toBeInTheDocument();

    act(() => {
      selectedThreadStream?.emit({
        id: "historical-item-upsert-external",
        seq: 2,
        kind: "timeline.item_upsert",
        codexMethod: "item/upsert",
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "agent-2",
        payload: {
          source: "appServerSnapshot",
          turnId: "turn-2",
          itemId: "agent-2",
          item: { id: "agent-2", type: "agentMessage", text: "External recovered snapshot" },
          itemSnapshot: { id: "agent-2", itemType: "agentMessage", rawPayload: {} },
        },
        receivedAt: "2026-04-30T00:00:03Z",
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /stop turn/i })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /send message/i })).toBeInTheDocument();
    const externalThreadButton = screen
      .getAllByRole("button", { name: /second thread/i })
      .find((button) => button.classList.contains("kodex-thread-select-button"));
    expect(externalThreadButton).toBeDefined();
    const externalThreadRow = externalThreadButton!.closest(".kodex-thread-list-button");
    expect(externalThreadRow?.querySelector(".kodex-thread-progress-indicator")).not.toBeInTheDocument();
    expect(externalThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).not.toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-2")).toHaveLength(2);
  });

  it("marks the selected thread seen from the loaded snapshot marker", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [{ ...thread, lastCompletedAgentTurnSeq: null, seenCompletedAgentTurnSeq: 0, unreadCompletedAgentTurn: false }],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/threads/thread-1": threadDetail(
          { ...thread, lastCompletedAgentTurnSeq: 2, seenCompletedAgentTurnSeq: 0, unreadCompletedAgentTurn: true },
          [snapshotTurn("turn-1", [snapshotItem("item-1", "agentMessage", { text: "Historical snapshot" })])],
        ),
        "POST /v1/threads/thread-1/seen": {
          threadId: "thread-1",
          seenCompletedAgentTurnSeq: 2,
          updatedAt: "2026-04-30T00:00:02Z",
        },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/historical snapshot/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/threads/thread-1/seen")).toHaveLength(1);
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/threads/thread-1/seen")[0])).resolves.toEqual({
      seenCompletedAgentTurnSeq: 2,
    });
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
        "GET /v1/threads/thread-1": threadDetail(thread, [
          snapshotTurn("turn-1", [snapshotItem("item-1", "agentMessage", { text: "First thread snapshot" })]),
        ]),
        "GET /v1/threads/thread-2": threadDetail(secondThread, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Second thread snapshot" })]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/first thread snapshot/i)).toBeInTheDocument();
    const firstThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
    expect(firstThreadStream).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: /second thread/i }));
    expect(await screen.findByText(/second thread snapshot/i)).toBeInTheDocument();

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
