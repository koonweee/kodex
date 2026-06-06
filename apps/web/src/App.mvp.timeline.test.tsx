import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventEnvelope } from "./api/client";
import { getLiveDiagnosticsSnapshot, resetLiveDiagnosticsForTest } from "./events/liveDiagnostics";
import {
  App,
  FakeEventSource,
  activeThread,
  appCss,
  baseRoutes,
  canonicalRowsFromSnapshotItems,
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

type FakeEventSourceInstance = InstanceType<typeof FakeEventSource>;

function eventSourceUrl(instance: FakeEventSourceInstance) {
  return new URL(instance.url, "http://localhost");
}

function workspaceStreamThreadIds(instance: FakeEventSourceInstance) {
  return (eventSourceUrl(instance).searchParams.get("threadIds") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

function sameThreadIdSet(left: string[], right: string[]) {
  return [...left].sort().join("\n") === [...right].sort().join("\n");
}

function workspaceNavigation() {
  return screen.getByRole("navigation", { name: /workspace/i });
}

function activeThreadPane() {
  const pane = document.querySelector<HTMLElement>('.kodex-thread-pane[data-workspace-pane-active="true"]');
  expect(pane).toBeInTheDocument();
  return pane as HTMLElement;
}

function activeSendButton() {
  return within(activeThreadPane()).getByRole("button", { name: /send message/i });
}

async function openSecondThreadInAdditionalPane() {
  await userEvent.click(screen.getByRole("button", { name: /thread actions/i }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /duplicate pane/i }));
  await userEvent.click(within(workspaceNavigation()).getByRole("button", { name: /second thread/i }));
}

function openWorkspaceStreams() {
  return FakeEventSource.instances.filter((instance) => {
    if (instance.closed) {
      return false;
    }
    const url = eventSourceUrl(instance);
    return url.pathname === "/v1/events" && url.searchParams.get("includeGlobal") === "true";
  });
}

function latestOpenWorkspaceStream() {
  const stream = openWorkspaceStreams().at(-1);
  expect(stream).toBeDefined();
  return stream!;
}

function expectWorkspaceStreamContract(instance: FakeEventSourceInstance, threadIds: string[]) {
  const url = eventSourceUrl(instance);
  expect(url.pathname).toBe("/v1/events");
  expect(url.searchParams.get("includeGlobal")).toBe("true");
  expect(url.searchParams.has("threadId")).toBe(false);
  expect(url.searchParams.has("excludeThreadId")).toBe(false);
  expect(sameThreadIdSet(workspaceStreamThreadIds(instance), threadIds)).toBe(true);
}

async function waitForWorkspaceStreamThreadIds(threadIds: string[]) {
  let stream: FakeEventSourceInstance | undefined;
  await waitFor(() => {
    stream = openWorkspaceStreams().find((instance) =>
      sameThreadIdSet(workspaceStreamThreadIds(instance), threadIds),
    );
    expect(stream).toBeDefined();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return openWorkspaceStreams()
    .filter((instance) => sameThreadIdSet(workspaceStreamThreadIds(instance), threadIds))
    .at(-1) ?? stream!;
}

function itemDeltaEvent({
  seq,
  delta,
  itemId = "missing-agent",
  turnId = "turn-missing",
}: {
  seq: number;
  delta: string;
  itemId?: string;
  turnId?: string;
}): EventEnvelope {
  return {
    id: `item-delta-${seq}`,
    seq,
    kind: "thread_view.item_delta",
    codexMethod: "thread_view/item_delta",
    projectId: project.id,
    threadId: thread.id,
    turnId,
    itemId,
    payload: {
      threadId: thread.id,
      turnId,
      itemId,
      delta,
      viewRevision: seq,
    },
    receivedAt: "2026-04-30T00:00:02Z",
  };
}

describe("MVP timeline flows", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
    resetLiveDiagnosticsForTest();
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

  it("uses one workspace stream for global events and subscribed thread panes", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    window.history.replaceState(null, "", "/threads/thread-1");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/threads/thread-1": threadDetail(thread, [
          snapshotTurn("turn-1", [snapshotItem("item-1", "agentMessage", { text: "Initial snapshot" })]),
        ]),
        "GET /v1/threads/thread-2": threadDetail(secondThread, [
          snapshotTurn("turn-2", [snapshotItem("item-2", "agentMessage", { text: "Second snapshot" })]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/initial snapshot/i)).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);
    expectWorkspaceStreamContract(workspaceStream, [thread.id]);
    expect(openWorkspaceStreams()).toHaveLength(1);

    act(() => {
      workspaceStream.emitNamed(
        "thread_view.patch",
        projectionPatchEvent({
          id: "active-pane-update",
          seq: 2,
          threadId: thread.id,
          text: "Active pane update",
        }),
      );
    });
    expect(await screen.findByText(/active pane update/i)).toBeInTheDocument();

    act(() => {
      workspaceStream.emitNamed(
        "thread_view.patch",
        projectionPatchEvent({
          id: "background-pane-update",
          seq: 3,
          threadId: secondThread.id,
          text: "Background pane update",
        }),
      );
    });
    expect(screen.queryByText(/background pane update/i)).not.toBeInTheDocument();
    act(() => {
      workspaceStream.emitNamed("gateway.warning", {
        id: "selected-thread-warning",
        seq: 4,
        kind: "gateway.warning",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "warning-1",
        payload: { message: "Selected warning routed" },
        receivedAt: "2026-05-27T00:00:00Z",
      });
    });
    expect(await screen.findByText(/selected warning routed/i)).toBeInTheDocument();
    act(() => {
      workspaceStream.emitNamed("gateway.error", {
        id: "selected-thread-error",
        seq: 5,
        kind: "gateway.error",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "error-1",
        payload: { message: "Selected error routed" },
        receivedAt: "2026-05-27T00:00:01Z",
      });
    });
    expect(await screen.findByText(/selected error routed/i)).toBeInTheDocument();

    await openSecondThreadInAdditionalPane();
    expect(await screen.findByText(/second snapshot/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /thread actions/i })).toHaveLength(3);
    });
    const firstThreadDetailCalls = gateway.callsFor("GET", "/v1/threads/thread-1").length;
    await userEvent.click(within(workspaceNavigation()).getByRole("button", { name: /implement frontend/i }));
    await waitFor(() => {
      expect(document.querySelector('.kodex-thread-pane[data-workspace-pane-active="true"]')).toHaveTextContent(
        /initial snapshot/i,
      );
    });
    expect(gateway.callsFor("GET", "/v1/threads/thread-1")).toHaveLength(firstThreadDetailCalls);

    const expandedWorkspaceStream = await waitForWorkspaceStreamThreadIds([thread.id, secondThread.id]);
    expectWorkspaceStreamContract(expandedWorkspaceStream, [thread.id, secondThread.id]);
  });

  it("reconnects the workspace stream with the live cursor and applies recovered active-pane events", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": threadDetail(thread, [
          snapshotTurn("turn-1", [
            snapshotItem("answer-1", "agentMessage", { text: "Initial snapshot" }),
          ]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/initial snapshot/i)).toBeInTheDocument();
    const initialStream = await waitForWorkspaceStreamThreadIds([thread.id]);
    expectWorkspaceStreamContract(initialStream, [thread.id]);

    act(() => {
      initialStream.emitNamed(
        "thread_view.patch",
        projectionPatchEvent({ id: "before-reconnect-live-update", seq: 5, text: "Before reconnect live update" }),
      );
    });
    expect(await screen.findByText(/before reconnect live update/i)).toBeInTheDocument();

    act(() => {
      initialStream.onerror?.();
    });
    expect(initialStream.closed).toBe(true);

    await waitFor(
      () => expect(openWorkspaceStreams()).toHaveLength(1),
      { timeout: 1500 },
    );
    const reconnectedStream = latestOpenWorkspaceStream();
    expect(reconnectedStream).not.toBe(initialStream);
    expectWorkspaceStreamContract(reconnectedStream, [thread.id]);
    expect(eventSourceUrl(reconnectedStream).searchParams.get("cursor")).toBe("5");

    act(() => {
      reconnectedStream.emitNamed(
        "thread_view.patch",
        projectionPatchEvent({ id: "recovered-live-update", seq: 6, text: "Recovered live update" }),
      );
    });

    expect(screen.queryByText(/selected thread stream disconnected/i)).not.toBeInTheDocument();
    expect(await screen.findByText(/recovered live update/i)).toBeInTheDocument();
  });

  it("retries empty rollout selected thread snapshot reads without reporting a hard load failure", async () => {
    window.history.replaceState(null, "", "/threads/thread-1");
    let detailReads = 0;
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": () => {
          detailReads += 1;
          if (detailReads === 1) {
            throw new Error(
              "app-server error -32603: failed to read thread: thread-store internal error: failed to read thread /Users/example/.codex/sessions/2026/05/20/rollout-2026-05-20T22-32-32-thread-1.jsonl: rollout at /Users/example/.codex/sessions/2026/05/20/rollout-2026-05-20T22-32-32-thread-1.jsonl is empty",
            );
          }
          return threadDetail(thread, [
            snapshotTurn("turn-1", [
              snapshotItem("answer-1", "agentMessage", { text: "Recovered from empty rollout" }),
            ]),
          ]);
        },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/recovered from empty rollout/i)).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-1")).toHaveLength(2);
    expect(screen.queryByText(/Selected thread load failed/i)).not.toBeInTheDocument();
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
    const commandDetails = Array.from(timeline.querySelectorAll("details.kodex-activity-item")).find((details) =>
      within(details as HTMLElement).queryByText("Ran pwd"),
    ) as HTMLDetailsElement;
    commandDetails.open = true;
    fireEvent(commandDetails, new Event("toggle"));
    expect(within(timeline).getByText("$ pwd")).toBeInTheDocument();
    expect(within(timeline).getByText("Searched web")).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: /implement frontend/i }));
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    act(() => {
      workspaceStream.emit({
        id: "event-running-thread-completed",
        seq: 3,
        kind: "thread_view.patch",
        codexMethod: "thread_view/patch",
        projectId: project.id,
        threadId: "thread-2",
        turnId: null,
        itemId: null,
        payload: { scope: "lifecycle", viewRevision: 3, threadId: "thread-2", activeTurnId: null, liveState: "idle" },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    await waitFor(() => {
      const updatedRunningThreadRow = screen
        .getByRole("button", { name: /running thread/i })
        .closest(".kodex-thread-list-button");
      expect(updatedRunningThreadRow?.querySelector(".kodex-thread-progress-indicator")).not.toBeInTheDocument();
      expect(updatedRunningThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).toBeInTheDocument();
    });
  });

  it("does not mark already represented completed turns unread when the workspace stream replays after refresh", async () => {
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
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    act(() => {
      workspaceStream.emit({
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

  it("refetches the active pane snapshot when the stream requires snapshot recovery", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let detailCall = 0;
    let resolveRecovery: (value: unknown) => void = () => undefined;
    const recoveryDetail = new Promise((resolve) => {
      resolveRecovery = resolve;
    });
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": () => {
          detailCall += 1;
          if (detailCall > 1) {
            return recoveryDetail;
          }
          return threadDetail(thread, [
            snapshotTurn("turn-1", [
              snapshotItem("item-1", "agentMessage", {
                text: "Initial snapshot",
              }),
            ]),
          ]);
        },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/initial snapshot/i)).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    act(() => {
      workspaceStream.emit({
        id: "snapshot-required-1",
        seq: 1,
        kind: "thread_view.refresh_required",
        codexMethod: "thread_view/refresh_required",
        projectId: project.id,
        threadId: thread.id,
        turnId: null,
        itemId: null,
        payload: { threadId: thread.id, reason: "lagged" },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(screen.queryByText(/gateway requested a selected thread refresh/i)).not.toBeInTheDocument();
    resolveRecovery(
      threadDetail(thread, [
        snapshotTurn("turn-1", [
          snapshotItem("item-1", "agentMessage", {
            text: "Recovered snapshot",
          }),
        ]),
      ]),
    );
    expect(await screen.findByText(/recovered snapshot/i)).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-1")).toHaveLength(2);
    expect(gateway.callsFor("GET", "/v1/events")).toHaveLength(0);
  });

  it("coalesces active pane snapshot recovery while delta misses keep arriving", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let detailCall = 0;
    const recoveryDetail = new Promise(() => undefined);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": () => {
          detailCall += 1;
          if (detailCall > 1) {
            return recoveryDetail;
          }
          return threadDetail(thread, [
            snapshotTurn("turn-1", [
              snapshotItem("item-1", "agentMessage", {
                text: "Initial snapshot",
              }),
            ]),
          ]);
        },
      }),
    );

    render(<App />);

    expect(await screen.findByText(/initial snapshot/i)).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    act(() => {
      workspaceStream.emitNamed("thread_view.item_delta", itemDeltaEvent({ seq: 2, delta: "First" }));
    });
    await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads/thread-1")).toHaveLength(2));

    act(() => {
      workspaceStream.emitNamed("thread_view.item_delta", itemDeltaEvent({ seq: 3, delta: "Second" }));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    act(() => {
      workspaceStream.emitNamed("thread_view.item_delta", itemDeltaEvent({ seq: 4, delta: "Third" }));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(gateway.callsFor("GET", "/v1/threads/thread-1")).toHaveLength(2);
  });

  it("does not recover when a patch creates the delta target in the same selected batch", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": threadDetail(thread, [
          snapshotTurn("turn-1", [
            snapshotItem("item-1", "agentMessage", {
              text: "Initial snapshot",
            }),
          ]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/initial snapshot/i)).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    act(() => {
      workspaceStream.emitNamed(
        "thread_view.patch",
        projectionPatchEvent({
          seq: 2,
          turnId: "turn-live",
          itemId: "agent-live",
          text: "Live update",
        }),
      );
      workspaceStream.emitNamed(
        "thread_view.item_delta",
        itemDeltaEvent({
          seq: 3,
          turnId: "turn-live",
          itemId: "agent-live",
          delta: " continued",
        }),
      );
    });

    expect(await screen.findByText(/live update continued/i)).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-1")).toHaveLength(1);
  });

  it("batches active Dockview pane workspace stream render events", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    window.history.pushState({}, "", "/threads/thread-1");
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": threadDetail(thread, [
          snapshotTurn("turn-1", [
            snapshotItem("item-1", "agentMessage", {
              text: "Initial snapshot",
            }),
          ]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/initial snapshot/i)).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);
    resetLiveDiagnosticsForTest();

    act(() => {
      workspaceStream.emitNamed(
        "thread_view.patch",
        projectionPatchEvent({
          seq: 2,
          turnId: "turn-live",
          itemId: "agent-live",
          text: "",
        }),
      );
      workspaceStream.emitNamed(
        "thread_view.item_delta",
        itemDeltaEvent({
          seq: 3,
          turnId: "turn-live",
          itemId: "agent-live",
          delta: "First",
        }),
      );
      workspaceStream.emitNamed(
        "thread_view.item_delta",
        itemDeltaEvent({
          seq: 4,
          turnId: "turn-live",
          itemId: "agent-live",
          delta: " streamed batch",
        }),
      );
    });

    expect(await screen.findByText(/first streamed batch/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(getLiveDiagnosticsSnapshot()).toMatchObject({
        reducerBatchCount: 1,
        reducerEventCount: 3,
      });
    });
    expect(gateway.callsFor("GET", "/v1/threads/thread-1")).toHaveLength(1);
  });

  it("keeps applying later Dockview pane patches after an orphan delta in the same batch", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    window.history.pushState({}, "", "/threads/thread-1");
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": threadDetail(thread, [
          snapshotTurn("turn-1", [
            snapshotItem("item-1", "agentMessage", {
              text: "Initial snapshot",
            }),
          ]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/initial snapshot/i)).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    act(() => {
      workspaceStream.emitNamed("thread_view.item_delta", itemDeltaEvent({ seq: 2, delta: "orphan" }));
      workspaceStream.emitNamed(
        "thread_view.patch",
        projectionPatchEvent({
          seq: 3,
          turnId: "turn-live",
          itemId: "agent-live",
          text: "Later valid patch",
        }),
      );
    });

    expect(await screen.findByText(/later valid patch/i)).toBeInTheDocument();
  });

  it("indexes empty running assistant patches so later deltas can append", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": threadDetail(thread, [
          snapshotTurn("turn-1", [
            snapshotItem("item-1", "agentMessage", {
              text: "Initial snapshot",
            }),
          ]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/initial snapshot/i)).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    act(() => {
      workspaceStream.emitNamed(
        "thread_view.patch",
        projectionPatchEvent({
          seq: 2,
          turnId: "turn-live",
          itemId: "agent-live",
          text: "",
        }),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    act(() => {
      workspaceStream.emitNamed(
        "thread_view.item_delta",
        itemDeltaEvent({
          seq: 3,
          turnId: "turn-live",
          itemId: "agent-live",
          delta: "First streamed token",
        }),
      );
    });

    expect(await screen.findByText(/first streamed token/i)).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-1")).toHaveLength(1);
  });

  it("applies active pane workspace stream patches", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(baseRoutes());

    render(<App />);

    expect(await screen.findByText(/hello from codex/i)).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    act(() => {
      workspaceStream.emit(projectionPatchEvent({
        id: "active-pane-stream-patch",
        seq: 2,
        threadId: thread.id,
        turnId: "turn-live",
        itemId: "historical-agent-1",
        text: "Workspace stream live event",
      }));
    });

    expect(await screen.findByText(/workspace stream live event/i)).toBeInTheDocument();
  });

  it("connects the workspace stream as soon as pane subscriptions are known", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveDetail: (value: unknown) => void = () => undefined;
    const detail = new Promise((resolve) => {
      resolveDetail = resolve;
    });
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": () => detail,
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);
    expectWorkspaceStreamContract(workspaceStream, [thread.id]);

    resolveDetail(
      threadDetail(thread, [
        snapshotTurn("turn-1", [snapshotItem("item-1", "agentMessage", { text: "Snapshot before live" })]),
      ]),
    );

    expect(await screen.findByText(/snapshot before live/i)).toBeInTheDocument();
  });

  it("does not use completed-turn markers as the workspace stream cursor", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const markerThread = { ...thread, lastCompletedAgentTurnSeq: 100 };
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [markerThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/threads/thread-1": threadDetail(markerThread, [
          snapshotTurn("turn-1", [snapshotItem("item-1", "agentMessage", { text: "High marker snapshot" })]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/high marker snapshot/i)).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);
    expect(eventSourceUrl(workspaceStream).searchParams.get("cursor")).not.toBe("100");

    act(() => {
      workspaceStream.emit(projectionPatchEvent({
        id: "low-seq-live-event-1",
        seq: 2,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-2",
        itemId: "low-seq-live-agent-1",
        text: "Low seq live event",
        displayOrder: 2,
      }));
    });

    expect(await screen.findByText(/low seq live event/i)).toBeInTheDocument();
  });

  it("clears the active stop state from a workspace thread view patch", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [activeThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/threads/thread-1": threadDetail(activeThread, [
          snapshotTurn("turn-1", [
            snapshotItem("agent-1", "agentMessage", {
              text: "Working answer",
            }),
          ], "running"),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/working answer/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stop turn/i })).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    act(() => {
      workspaceStream.emitNamed("thread_view.patch", terminalProjectionEvent({
        seq: 5,
        text: "Final answer from workspace stream",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "agent-1",
      }));
    });

    expect(await screen.findByText(/final answer from workspace stream/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /stop turn/i })).not.toBeInTheDocument();
    });
    expect(activeSendButton()).toBeInTheDocument();
  });

  it("keeps a resumed idle external thread in send state after pane snapshot recovery", async () => {
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
        "POST /v1/threads/thread-2/attach": { disposition: "resumed", thread: resumedThread, rawPayload: {} },
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

    await openSecondThreadInAdditionalPane();
    expect(await screen.findByText(/external completed snapshot/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /stop turn/i })).not.toBeInTheDocument();
    expect(activeSendButton()).toBeInTheDocument();
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id, secondThread.id]);

    act(() => {
      workspaceStream.emit({
        id: "snapshot-required-external",
        seq: 1,
        kind: "thread_view.refresh_required",
        codexMethod: "thread_view/refresh_required",
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
      workspaceStream.emit({
        id: "historical-projection-external",
        seq: 2,
        kind: "thread_view.patch",
        codexMethod: "thread_view/patch",
        projectId: project.id,
        threadId: "thread-2",
        turnId: null,
        itemId: null,
        payload: {
          scope: "full_snapshot",
          viewRevision: 2,
          threadId: "thread-2",
          activeTurnId: null,
          liveState: "idle",
          rows: canonicalRowsFromSnapshotItems([
            {
              id: "projection-turn-2-agent-2",
              threadId: "thread-2",
              turnId: "turn-2",
              itemId: "agent-2",
              itemType: "agentMessage",
              displayOrder: 2,
              status: "completed",
              timestampMs: 2,
              payload: {
                item: { id: "agent-2", type: "agentMessage", text: "External recovered snapshot" },
              },
            },
          ]),
          items: [
            {
              id: "projection-turn-2-agent-2",
              threadId: "thread-2",
              turnId: "turn-2",
              itemId: "agent-2",
              itemType: "agentMessage",
              displayOrder: 2,
              status: "completed",
              codexMethod: "item/completed",
              timestampMs: 2,
              payload: {
                source: "appServerSnapshot",
                turnId: "turn-2",
                itemId: "agent-2",
                item: { id: "agent-2", type: "agentMessage", text: "External recovered snapshot" },
                itemSnapshot: { id: "agent-2", itemType: "agentMessage", rawPayload: {} },
              },
            },
          ],
        },
        receivedAt: "2026-04-30T00:00:03Z",
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /stop turn/i })).not.toBeInTheDocument();
    });
    expect(activeSendButton()).toBeInTheDocument();
    const externalThreadButton = screen
      .getAllByRole("button", { name: /second thread/i })
      .find((button) => button.classList.contains("kodex-thread-select-button"));
    expect(externalThreadButton).toBeDefined();
    const externalThreadRow = externalThreadButton!.closest(".kodex-thread-list-button");
    expect(externalThreadRow?.querySelector(".kodex-thread-progress-indicator")).not.toBeInTheDocument();
    expect(externalThreadRow?.querySelector(".kodex-thread-unread-agent-turn-indicator")).not.toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-2")).toHaveLength(2);
  });

  it("does not persist read state from pane snapshot loads", async () => {
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
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/seen")).toHaveLength(0);
    const workspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    act(() => {
      workspaceStream.emit({
        id: "event-active-read-state",
        seq: 3,
        kind: "thread.read_updated",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: null,
        itemId: null,
        payload: {
          threadId: thread.id,
          seenCompletedAgentTurnSeq: 2,
          lastCompletedAgentTurnSeq: 2,
          unreadCompletedAgentTurn: false,
        },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });
    expect(gateway.callsFor("POST", "/v1/threads/thread-1/seen")).toHaveLength(0);
  });

  it("keeps the active pane isolated from late events after workspace stream subscription changes", async () => {
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

    const { container } = render(<App />);

    expect(await screen.findByText(/first thread snapshot/i)).toBeInTheDocument();
    const initialWorkspaceStream = await waitForWorkspaceStreamThreadIds([thread.id]);

    await openSecondThreadInAdditionalPane();
    expect(await screen.findByText(/second thread snapshot/i)).toBeInTheDocument();
    await waitForWorkspaceStreamThreadIds([thread.id, secondThread.id]);
    expect(initialWorkspaceStream.closed).toBe(true);

    act(() => {
      initialWorkspaceStream.emitNamed(
        "thread_view.patch",
        projectionPatchEvent({
        id: "event-stale-closed-stream",
        seq: 2,
        projectId: project.id,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        text: "Stale closed stream update",
      }),
      );
    });

    await waitFor(() => {
      expect(within(timelineElement(container)).queryByText(/stale closed stream update/i)).not.toBeInTheDocument();
    });
  });

});

function terminalProjectionEvent({
  itemId,
  seq,
  text,
  threadId,
  turnId,
}: {
  itemId: string;
  seq: number;
  text: string;
  threadId: string;
  turnId: string;
}): EventEnvelope {
  return {
    id: `terminal-projection-${seq}`,
    seq,
    kind: "thread_view.patch",
    codexMethod: "thread_view/patch",
    projectId: project.id,
    threadId,
    turnId: null,
    itemId: null,
    payload: {
      scope: "turn",
      viewRevision: seq,
      threadId,
      activeTurnId: null,
      liveState: "idle",
      turns: [{ id: turnId, status: "completed" }],
      pendingApprovalRequests: [],
      pendingUserInputRequests: [],
      affectedTurnIds: [turnId],
      rows: canonicalRowsFromSnapshotItems([
        {
          id: `projection-${turnId}-${itemId}`,
          threadId,
          turnId,
          itemId,
          itemType: "agentMessage",
          status: "completed",
          displayOrder: seq,
          timestampMs: seq,
          payload: {
            item: { id: itemId, type: "agentMessage", phase: "final_answer", text },
          },
        },
      ]),
      items: [
        {
          id: `projection-${turnId}-${itemId}`,
          threadId,
          turnId,
          itemId,
          itemType: "agentMessage",
          status: "completed",
          displayOrder: seq,
          codexMethod: "item/completed",
          timestampMs: seq,
          payload: {
            source: "gatewayStream",
            turnId,
            itemId,
            item: { id: itemId, type: "agentMessage", phase: "final_answer", text },
            itemSnapshot: {
              id: itemId,
              itemType: "agentMessage",
              text,
              rawPayload: { id: itemId, type: "agentMessage", phase: "final_answer", text },
              skillMentions: [],
            },
          },
        },
      ],
    },
    receivedAt: "2026-04-30T00:00:03Z",
  };
}
