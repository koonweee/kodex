import { compactCanonicalPayload } from "../../test/canonicalPayloadFixture";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import type { EventEnvelope, ThreadSummary, ThreadViewResponse } from "../../api/client";
import { mockGateway } from "../../test/gatewayMock";
import { createMemoryWorkspacePaneStore } from "../../workspace/paneStore";
import { WorkspaceProvider, useWorkspace, type ThreadPaneTimelineActionHandler } from "../../workspace/WorkspaceProvider";
import { ThreadPane } from "./ThreadPane";

class UnopenedEventSource {
  static instances: UnopenedEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { UnopenedEventSource.instances.push(this); }
  addEventListener() {}
  close() {}
  emit(event: EventEnvelope) { this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>); }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  UnopenedEventSource.instances = [];
});

it("loads each client's editable pane from one attach snapshot and reattaches on stream recovery", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  let snapshot: ThreadViewResponse = {
    thread: {
      id: "shared", name: "Native initial page", projectId: null, cwd: "/native",
      status: "idle", notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false,
      unreadCompletedAgentTurn: false, createdAt: 1, updatedAt: 2,
      parentThreadId: null, canAcceptDirectInput: true,
    },
    liveState: "idle",
    timeline: { liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 1 },
  };
  let holdReads = false;
  const heldReads: Array<{ signal: AbortSignal; resolve: (value: ThreadViewResponse) => void }> = [];
  const gateway = mockGateway({
    "GET /v1/threads/shared": () => snapshot,
    "POST /v1/threads/shared/attach": (request: Request) => holdReads
      ? new Promise<ThreadViewResponse>(resolve => heldReads.push({ signal: request.signal, resolve }))
      : snapshot,
    "GET /v1/threads/shared/app-surface": { session: null },
  });
  for (const client of ["first", "second"]) {
    const actions = new Set<ThreadPaneTimelineActionHandler>();
    const store = createMemoryWorkspacePaneStore({
      schemaVersion: 1, activePaneId: client, dockviewLayout: null,
      panes: [{ id: client, kind: "thread", target: { mode: "existing", threadId: "shared" } }],
    });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MantineProvider><WorkspaceProvider paneStore={store}
        publishThreadPaneTimelineAction={(action) => actions.forEach((handler) => handler(action))}
        subscribeThreadPaneTimelineAction={(handler) => { actions.add(handler); return () => { actions.delete(handler); }; }}
        renderThreadComposer={(_pane, state) => <div role="status">{client}: {state.isReady ? "ready" : "loading"}</div>}>
        <ActiveThreadPane />
      </WorkspaceProvider></MantineProvider>
    </QueryClientProvider>);
  }
  expect(await screen.findByText("first: ready")).toBeInTheDocument();
  expect(await screen.findByText("second: ready")).toBeInTheDocument();
  expect(gateway.callsFor("POST", "/v1/threads/shared/attach")).toHaveLength(2);
  expect(gateway.callsFor("GET", "/v1/threads/shared")).toHaveLength(0);

  const streams = UnopenedEventSource.instances.slice();
  expect(streams).toHaveLength(2);
  act(() => streams.forEach((stream) => stream.onopen?.()));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/shared/attach")).toHaveLength(4));
  snapshot = { ...snapshot, thread: { ...snapshot.thread, name: "Recovered native page" }, timeline: { ...snapshot.timeline!, viewRevision: 2 } };
  act(() => streams.forEach((stream) => stream.onerror?.()));
  await waitFor(() => expect(UnopenedEventSource.instances).toHaveLength(4), { timeout: 2_000 });
  act(() => UnopenedEventSource.instances.slice(2).forEach((stream) => stream.onopen?.()));
  await waitFor(() => expect(screen.getAllByRole("heading", { name: "Recovered native page" })).toHaveLength(2));
  expect(gateway.callsFor("POST", "/v1/threads/shared/attach")).toHaveLength(6);
  expect(gateway.callsFor("GET", "/v1/threads/shared")).toHaveLength(0);

  holdReads = true;
  const recoveredStreams = UnopenedEventSource.instances.slice(2);
  const refresh = (seq: number): EventEnvelope => ({
    id: `refresh-${seq}`, seq, kind: "thread_view.refresh_required", threadId: "shared",
    payload: { threadId: "shared", reason: "snapshot_required" }, receivedAt: "2026-10-07T00:00:00Z",
  });
  act(() => recoveredStreams.forEach(stream => stream.emit(refresh(3))));
  await waitFor(() => expect(heldReads).toHaveLength(2));
  expect(screen.getByText("first: ready")).toBeVisible();
  expect(screen.getByText("second: ready")).toBeVisible();
  act(() => recoveredStreams.forEach(stream => stream.emit(refresh(4))));
  await waitFor(() => expect(heldReads).toHaveLength(4));
  expect(heldReads.slice(0, 2).every(read => read.signal.aborted)).toBe(true);
  expect(screen.getByText("first: ready")).toBeVisible();
  expect(screen.getByText("second: ready")).toBeVisible();
  await act(async () => heldReads.forEach(read => read.resolve(snapshot)));
  expect(screen.getByText("first: ready")).toBeVisible();
  expect(screen.getByText("second: ready")).toBeVisible();
});

it("loads the canonical initial snapshot after StrictMode cleanup without waiting for the event stream", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const snapshot: ThreadViewResponse = {
    thread: {
      id: "thread-strict", name: "Canonical chat", projectId: "native-project", cwd: "/canonical",
      status: "idle", notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false,
      unreadCompletedAgentTurn: false, createdAt: 1, updatedAt: 2,
      parentThreadId: null, canAcceptDirectInput: null,
    },
    liveState: "idle",
    timeline: {
      liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 1,
    },
  };
  let releaseAborted: (value: ThreadViewResponse) => void = () => undefined;
  const abortedReply = new Promise<ThreadViewResponse>((resolve) => { releaseAborted = resolve; });
  const signals: AbortSignal[] = [];
  mockGateway({
    "POST /v1/threads/thread-strict/attach": (request: Request) => {
      signals.push(request.signal);
      return signals.length === 1 ? abortedReply : snapshot;
    },
    "GET /v1/threads/thread-strict/app-surface": { session: null },
  });
  const onLoaded = vi.fn();
  const onFailed = vi.fn();
  const store = createMemoryWorkspacePaneStore({
    schemaVersion: 1, activePaneId: "pane-strict", dockviewLayout: null,
    panes: [{ id: "pane-strict", kind: "thread", target: { mode: "existing", threadId: "thread-strict" } }],
  });
  render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MantineProvider>
          <WorkspaceProvider paneStore={store} onThreadSnapshotLoaded={onLoaded} onThreadSnapshotLoadFailed={onFailed}
            renderThreadComposer={(_pane, state) => <div role="status">{state.isReady ? "Chat ready" : "Chat loading"}</div>}>
            <ActiveThreadPane />
          </WorkspaceProvider>
        </MantineProvider>
      </QueryClientProvider>
    </StrictMode>,
  );

  expect(await screen.findByText("Chat ready")).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Canonical chat" })).toBeInTheDocument();
  expect(signals).toHaveLength(2);
  expect(signals[0].aborted).toBe(true);
  expect(onLoaded).toHaveBeenCalledTimes(1);
  expect(onLoaded).toHaveBeenCalledWith(expect.objectContaining({ projectId: "native-project", cwd: "/canonical" }));
  await act(async () => { releaseAborted({ ...snapshot, thread: { ...snapshot.thread, name: "Obsolete chat", projectId: null } }); });
  await waitFor(() => expect(screen.getByRole("heading", { name: "Canonical chat" })).toBeInTheDocument());
  expect(onLoaded).toHaveBeenCalledTimes(1);
  expect(onFailed).not.toHaveBeenCalled();
});

it("commits one editable-pane refill in StrictMode and queues one newer repair behind a held attach", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const snapshot = (text: string, viewRevision: number): ThreadViewResponse => ({
    thread: {
      id: "shared", name: "Shared chat", projectId: null, cwd: "/native", status: "active",
      notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null,
      readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false,
      createdAt: 1, updatedAt: 2, parentThreadId: null, canAcceptDirectInput: true,
    },
    liveState: "streaming",
    timeline: {
      liveState: "streaming", activeTurnId: "turn-1", pendingApprovalRequests: [], pendingUserInputRequests: [],
      viewRevision, turns: [{ id: "turn-1", status: "inProgress" }],
      rows: [{
        id: "answer", kind: "assistant_message", displayOrder: 1, status: "inProgress", turnId: "turn-1",
        items: [], fileChanges: [], collapsedRows: [],
        item: {
          id: "answer", itemId: "answer", itemType: "agentMessage", threadId: "shared", turnId: "turn-1",
          status: "inProgress", displayOrder: 1, codexMethod: "item/started",
          payload: compactCanonicalPayload({ id: "answer", type: "agentMessage", text }, { id: "answer", itemType: "agentMessage" }),
        },
      }],
    },
  });
  let reply: ThreadViewResponse | Promise<ThreadViewResponse> = snapshot("Base", 1);
  const signals: AbortSignal[] = [];
  const gateway = mockGateway({
    "POST /v1/threads/shared/attach": (request: Request) => { signals.push(request.signal); return reply; },
    "GET /v1/threads/shared/app-surface": { session: null },
  });
  const store = createMemoryWorkspacePaneStore({
    schemaVersion: 1, activePaneId: "shared-pane", dockviewLayout: null,
    panes: [{ id: "shared-pane", kind: "thread", target: { mode: "existing", threadId: "shared" } }],
  });
  render(<StrictMode><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MantineProvider><WorkspaceProvider paneStore={store}><ActiveThreadPane /></WorkspaceProvider></MantineProvider>
  </QueryClientProvider></StrictMode>);
  // Streaming decoration may split a paragraph across text nodes.
  const messageText = (text: string) => (_content: string, element: Element | null) =>
    element?.tagName === "P" && element.textContent === text;
  expect(await screen.findByText(messageText("Base"))).toBeInTheDocument();
  const initialReads = signals.length;
  const stream = UnopenedEventSource.instances.at(-1)!;
  let releaseEarlier!: (value: ThreadViewResponse) => void;
  reply = new Promise<ThreadViewResponse>((resolve) => { releaseEarlier = resolve; });
  const delta = (text: string, revision: number): EventEnvelope => ({
    id: `delta-${revision}`, seq: revision, kind: "thread_view.item_delta", threadId: "shared", turnId: "turn-1", itemId: "answer",
    receivedAt: "2026-10-05T00:00:00Z",
    payload: { threadId: "shared", turnId: "turn-1", itemId: "answer", delta: text, viewRevision: revision },
  });
  await act(async () => {
    stream.emit({
      id: "lifecycle-3", seq: 3, kind: "thread_view.patch", threadId: "shared", receivedAt: "2026-10-05T00:00:00Z",
      payload: { scope: "lifecycle", threadId: "shared", viewRevision: 3, liveState: "streaming", activeTurnId: "turn-1", pendingApprovalRequests: [], pendingUserInputRequests: [] },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  expect(signals).toHaveLength(initialReads);
  act(() => stream.emit(delta(" A", 2)));
  await waitFor(() => expect(signals).toHaveLength(initialReads + 1));
  expect(signals[initialReads].aborted).toBe(false);
  act(() => stream.emit(delta(" B", 4)));
  expect(await screen.findByText(messageText("Base B"))).toBeInTheDocument();
  // Editable panes retain the current read, then perform one queued newer read.
  expect(signals).toHaveLength(initialReads + 1);
  let releaseNewer!: (value: ThreadViewResponse) => void;
  reply = new Promise<ThreadViewResponse>((resolve) => { releaseNewer = resolve; });
  await act(async () => releaseEarlier(snapshot("Base A", 3)));
  await waitFor(() => expect(signals).toHaveLength(initialReads + 2));
  expect(screen.getByText(messageText("Base B"))).toBeInTheDocument();
  expect(signals[initialReads + 1].aborted).toBe(false);
  await act(async () => releaseNewer(snapshot("Base A B", 4)));
  expect(await screen.findByText(messageText("Base A B"))).toBeInTheDocument();
  await act(async () => {
    stream.emit(delta(" A", 2));
    stream.emit(delta(" B", 4));
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
  expect(signals).toHaveLength(initialReads + 2);
  expect(screen.getAllByText(messageText("Base A B"))).toHaveLength(1);
  expect(gateway.callsFor("GET", "/v1/threads/shared")).toHaveLength(0);
});

it("shows a native attach failure without a prose-based retry loop and recovers on stream open", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const snapshot: ThreadViewResponse = {
    thread: {
      id: "unavailable", name: "Recovered chat", projectId: null, cwd: "/native", status: "idle",
      notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false,
      createdAt: 1, updatedAt: 2, parentThreadId: null, canAcceptDirectInput: true,
    },
    liveState: "idle",
    timeline: { liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 1 },
  };
  let unavailable = true;
  const gateway = mockGateway({
    "POST /v1/threads/unavailable/attach": () => unavailable
      ? new Response(JSON.stringify({ code: "app_server_error", message: "Failed to load thread history", retryable: true }), { status: 502, headers: { "Content-Type": "application/json" } })
      : snapshot,
    "GET /v1/threads/unavailable/app-surface": { session: null },
  });
  const actions = new Set<ThreadPaneTimelineActionHandler>();
  const store = createMemoryWorkspacePaneStore({
    schemaVersion: 1, activePaneId: "unavailable-pane", dockviewLayout: null,
    panes: [{ id: "unavailable-pane", kind: "thread", target: { mode: "existing", threadId: "unavailable" } }],
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MantineProvider><WorkspaceProvider paneStore={store}
      publishThreadPaneTimelineAction={(action) => actions.forEach((handler) => handler(action))}
      subscribeThreadPaneTimelineAction={(handler) => { actions.add(handler); return () => { actions.delete(handler); }; }}>
      <ActiveThreadPane />
    </WorkspaceProvider></MantineProvider>
  </QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "Thread not found or unavailable" })).toBeInTheDocument();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(gateway.callsFor("POST", "/v1/threads/unavailable/attach")).toHaveLength(1);
  unavailable = false;
  act(() => UnopenedEventSource.instances.at(-1)?.onopen?.());
  expect(await screen.findByRole("heading", { name: "Recovered chat" })).toBeInTheDocument();
  expect(gateway.callsFor("POST", "/v1/threads/unavailable/attach")).toHaveLength(2);
});

it("closes a cold-restored archived pane without showing the unavailable state", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  mockGateway({
    "POST /v1/threads/archived/attach": new Response(
      JSON.stringify({ code: "thread_archived", message: "Thread archived", retryable: false }),
      { status: 410, headers: { "Content-Type": "application/json" } },
    ),
  });
  const onArchived = vi.fn();
  const onFailed = vi.fn();
  const store = createMemoryWorkspacePaneStore({
    schemaVersion: 1,
    activePaneId: "archived-pane",
    dockviewLayout: null,
    panes: [{ id: "archived-pane", kind: "thread", target: { mode: "existing", threadId: "archived" } }],
  });

  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MantineProvider><WorkspaceProvider
      onThreadArchived={onArchived}
      onThreadSnapshotLoadFailed={onFailed}
      paneStore={store}
      renderThreadComposer={() => <div>Draft ready</div>}
    ><ActiveThreadPane /></WorkspaceProvider></MantineProvider>
  </QueryClientProvider>);

  await waitFor(() => expect(onArchived).toHaveBeenCalledOnce());
  expect(await screen.findByText("Draft ready")).toBeInTheDocument();
  expect(store.getState().panes).toHaveLength(1);
  expect(store.getState().panes[0]).toMatchObject({ kind: "thread", target: { mode: "draft" } });
  expect(screen.queryByRole("heading", { name: "Thread not found or unavailable" })).not.toBeInTheDocument();
  expect(onArchived).toHaveBeenCalledWith("archived");
  expect(onFailed).not.toHaveBeenCalled();
});

it("closes the same archived thread in two workspace clients after native confirmation", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const snapshot: ThreadViewResponse = {
    thread: {
      id: "shared-archive", name: "Shared archive", projectId: null, cwd: "/native", status: "idle",
      notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null,
      readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false, createdAt: 1, updatedAt: 2,
      parentThreadId: null, canAcceptDirectInput: true,
    },
    liveState: "idle",
    timeline: { liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 1 },
  };
  let archived = false;
  mockGateway({
    "POST /v1/threads/shared-archive/attach": () => archived
      ? new Response(
          JSON.stringify({ code: "thread_archived", message: "Thread shared-archive is archived", retryable: false }),
          { status: 410, headers: { "Content-Type": "application/json" } },
        )
      : snapshot,
    "GET /v1/threads/shared-archive/app-surface": { session: null },
  });
  const stores = ["first", "second"].map((id) => createMemoryWorkspacePaneStore({
    schemaVersion: 1,
    activePaneId: `${id}-pane`,
    dockviewLayout: null,
    panes: [{ id: `${id}-pane`, kind: "thread", target: { mode: "existing", threadId: "shared-archive" } }],
  }));
  stores.forEach((store, index) => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MantineProvider><WorkspaceProvider paneStore={store} renderThreadComposer={() => <div>{index}: draft</div>}>
        <ActiveThreadPane />
      </WorkspaceProvider></MantineProvider>
    </QueryClientProvider>,
  ));
  await waitFor(() => expect(screen.getAllByRole("heading", { name: "Shared archive" })).toHaveLength(2));
  const streams = UnopenedEventSource.instances.slice();
  expect(streams).toHaveLength(2);

  archived = true;
  act(() => streams.forEach((stream, index) => stream.emit(threadCatalogEvent("thread/archived", index + 1))));

  await waitFor(() => stores.forEach((store) => {
    expect(store.getState().panes).toHaveLength(1);
    expect(store.getState().panes[0]).toMatchObject({ kind: "thread", target: { mode: "draft" } });
  }));
});

it("keeps an available pane open across replayed archive and unarchive markers", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const snapshot: ThreadViewResponse = {
    thread: {
      id: "replayed", name: "Available again", projectId: null, cwd: "/native", status: "idle",
      notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null,
      readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false, createdAt: 1, updatedAt: 2,
      parentThreadId: null, canAcceptDirectInput: true,
    },
    liveState: "idle",
    timeline: { liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 1 },
  };
  const gateway = mockGateway({
    "POST /v1/threads/replayed/attach": snapshot,
    "GET /v1/threads/replayed/app-surface": { session: null },
  });
  const onArchived = vi.fn();
  const store = createMemoryWorkspacePaneStore({
    schemaVersion: 1,
    activePaneId: "replayed-pane",
    dockviewLayout: null,
    panes: [{ id: "replayed-pane", kind: "thread", target: { mode: "existing", threadId: "replayed" } }],
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MantineProvider><WorkspaceProvider onThreadArchived={onArchived} paneStore={store}>
      <ActiveThreadPane />
    </WorkspaceProvider></MantineProvider>
  </QueryClientProvider>);
  expect(await screen.findByRole("heading", { name: "Available again" })).toBeInTheDocument();
  const stream = UnopenedEventSource.instances.at(-1)!;

  act(() => {
    stream.emit(threadCatalogEvent("thread/archived", 1, "replayed"));
    stream.emit(threadCatalogEvent("thread/unarchived", 2, "replayed"));
  });

  await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/replayed/attach").length).toBeGreaterThan(1));
  expect(store.getState().panes[0]).toMatchObject({ kind: "thread", target: { mode: "existing", threadId: "replayed" } });
  expect(screen.getByRole("heading", { name: "Available again" })).toBeInTheDocument();
  expect(onArchived).not.toHaveBeenCalled();
});

it("keeps direct-input capability owned by canonical detail when older sidebar and metadata summaries arrive", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const seed: ThreadSummary = {
    id: "child", parentThreadId: "parent", canAcceptDirectInput: null, name: "Child", cwd: "/native",
    projectId: null, status: "idle", notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false,
    unreadCompletedAgentTurn: false, createdAt: 1, updatedAt: 2, rawPayload: {},
  };
  let detail: ThreadViewResponse = {
    thread: { ...seed, canAcceptDirectInput: false }, liveState: "idle",
    timeline: { liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 1 },
  };
  let releaseInitial!: (value: ThreadViewResponse) => void;
  const initialReply = new Promise<ThreadViewResponse>((resolve) => { releaseInitial = resolve; });
  const signals: AbortSignal[] = [];
  const gateway = mockGateway({
    "POST /v1/threads/child/attach": (request: Request) => { signals.push(request.signal); return signals.length === 1 ? initialReply : detail; },
    "GET /v1/threads/child/app-surface": { session: null },
  });
  const store = createMemoryWorkspacePaneStore({
    schemaVersion: 1, activePaneId: "pane-child", dockviewLayout: null,
    panes: [{ id: "pane-child", kind: "thread", target: { mode: "existing", threadId: "child" } }],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onLoaded = vi.fn();
  const onFailed = vi.fn();
  const tree = (listed: ThreadSummary) => <QueryClientProvider client={client}><MantineProvider>
    <WorkspaceProvider paneStore={store} threadSummariesById={{ child: listed }} onThreadSnapshotLoaded={onLoaded} onThreadSnapshotLoadFailed={onFailed}
      renderThreadComposer={(_pane, state) => <div role="status">Native input: {String(state.thread?.canAcceptDirectInput)}</div>}>
      <ActiveThreadPane />
    </WorkspaceProvider>
  </MantineProvider></QueryClientProvider>;
  const view = render(tree(seed));
  await waitFor(() => expect(UnopenedEventSource.instances.length).toBeGreaterThan(0));
  const source = UnopenedEventSource.instances.at(-1)!;
  act(() => source.emit({ id: "unrelated-change", seq: 1, kind: "thread.subagents_changed", payload: { changedThreadId: "another-chat" }, receivedAt: "2026-10-04T00:00:00Z" }));
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(false);
  await act(async () => releaseInitial(detail));
  expect(await screen.findByText("Native input: false")).toBeInTheDocument();
  view.rerender(tree({ ...seed, name: "List rename", preview: "Native persisted preview" }));
  expect(await screen.findByRole("heading", { name: "List rename" })).toBeVisible();
  expect(store.getState().panes[0].title).toBe("List rename");
  expect(screen.getByText("Native input: false")).toBeInTheDocument();
  act(() => source.emit({ id: "persisted-summary", seq: 2, kind: "thread.summary_changed", threadId: "child", payload: { threadId: "child" }, receivedAt: "2026-10-07T00:00:00Z" }));
  expect(signals).toHaveLength(1);

  detail = { ...detail, thread: { ...detail.thread, canAcceptDirectInput: true } };
  act(() => source.emit({ id: "native-change", seq: 2, kind: "thread.subagents_changed", payload: { changedThreadId: "child" }, receivedAt: "2026-10-04T00:00:00Z" }));
  expect(await screen.findByText("Native input: true")).toBeInTheDocument();
  expect(gateway.callsFor("POST", "/v1/threads/child/attach")).toHaveLength(2);
  act(() => source.emit({ id: "old-metadata", seq: 3, threadId: "child", kind: "timeline.thread_metadata", payload: { thread: { ...seed, canAcceptDirectInput: false } }, receivedAt: "2026-10-04T00:00:00Z" }));
  expect(screen.getByText("Native input: true")).toBeInTheDocument();
});

it("fences a pre-input attach when a persisted native summary marker arrives", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const native: ThreadViewResponse = {
    thread: { id: "fresh", name: null, preview: "Persisted first prompt", projectId: null, cwd: "/native", status: "active",
      notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0,
      readStateKnown: false, unreadCompletedAgentTurn: false, createdAt: 1, updatedAt: 2, parentThreadId: null, canAcceptDirectInput: true },
    liveState: "streaming", timeline: { liveState: "streaming", activeTurnId: "turn", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [{ id: "turn", status: "inProgress" }], viewRevision: 2 },
  };
  const stale = { ...native, thread: { ...native.thread, preview: null } };
  let releaseOld!: (reply: ThreadViewResponse) => void;
  const old = new Promise<ThreadViewResponse>((resolve) => { releaseOld = resolve; });
  const signals: AbortSignal[] = [];
  mockGateway({
    "POST /v1/threads/fresh/attach": (request: Request) => { signals.push(request.signal); return signals.length === 1 ? old : native; },
    "GET /v1/threads/fresh/app-surface": { session: null },
  });
  const store = createMemoryWorkspacePaneStore({ schemaVersion: 1, activePaneId: "fresh-pane", dockviewLayout: null,
    panes: [{ id: "fresh-pane", kind: "thread", title: "New thread", target: { mode: "existing", threadId: "fresh" } }] });
  const seed: ThreadSummary = { ...stale.thread, rawPayload: {} };
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (thread: ThreadSummary) => <QueryClientProvider client={query}><MantineProvider><WorkspaceProvider
    paneStore={store} threadSummariesById={{ fresh: thread }}><ActiveThreadPane /></WorkspaceProvider></MantineProvider></QueryClientProvider>;
  const view = render(tree(seed));
  await waitFor(() => expect(signals).toHaveLength(1));
  view.rerender(tree({ ...native.thread, rawPayload: {} }));
  expect(await screen.findByRole("heading", { name: "Persisted first prompt" })).toBeVisible();
  act(() => UnopenedEventSource.instances.at(-1)!.emit({ id: "persisted-user", seq: 2, kind: "thread.summary_changed", threadId: "fresh", payload: { threadId: "fresh" }, receivedAt: "2026-10-07T00:00:00Z" }));
  await waitFor(() => expect(signals[0].aborted).toBe(true));
  await waitFor(() => expect(signals).toHaveLength(2));
  await act(async () => releaseOld(stale));
  expect(screen.getByRole("heading", { name: "Persisted first prompt" })).toBeVisible();
  expect(store.getState().panes[0].title).toBe("Persisted first prompt");
});

it.each([false, true])("closes an unavailable pane and keeps a usable workspace (another pane: %s)", async (hasOtherPane) => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  mockGateway({
    "POST /v1/threads/missing/attach": new Response(JSON.stringify({ code: "not_found", message: "Missing thread", retryable: false }), { status: 404, headers: { "Content-Type": "application/json" } }),
  });
  const store = createMemoryWorkspacePaneStore({
    schemaVersion: 1, activePaneId: "missing-pane", dockviewLayout: null,
    panes: [
      { id: "missing-pane", kind: "thread", target: { mode: "existing", threadId: "missing" } },
      ...(hasOtherPane ? [{ id: "other-pane", kind: "thread" as const, target: { mode: "draft" as const } }] : []),
    ],
  });
  const browse = vi.fn();
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MantineProvider env="test"><WorkspaceProvider paneStore={store} onShowMobileSidebar={browse}
      renderThreadComposer={() => <div>Ready to compose</div>}>
      <ActiveThreadPane />
    </WorkspaceProvider></MantineProvider>
  </QueryClientProvider>);
  await screen.findByRole("heading", { name: "Thread not found or unavailable" });
  fireEvent.click(screen.getByRole("button", { name: "Browse threads" }));
  expect(browse).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
  expect(await screen.findByText("Ready to compose")).toBeInTheDocument();
  await waitFor(async () => {
    const workspace = await store.load();
    expect(workspace?.panes).toHaveLength(1);
    expect(workspace?.panes[0].id).not.toBe("missing-pane");
    expect(workspace?.activePaneId).toBe(workspace?.panes[0].id);
    if (hasOtherPane) expect(workspace?.panes[0].id).toBe("other-pane");
  });
});

function ActiveThreadPane() {
  const { workspace } = useWorkspace();
  return <ThreadPane isActive pane={workspace.panes[0]} />;
}

function threadCatalogEvent(method: "thread/archived" | "thread/unarchived", seq: number, threadId = "shared-archive"): EventEnvelope {
  return {
    codexMethod: method,
    id: `${method}-${seq}`,
    itemId: null,
    kind: "thread.subagents_changed",
    payload: { changedThreadId: threadId },
    projectId: null,
    receivedAt: "2026-10-08T00:00:00Z",
    seq,
    threadId: null,
    turnId: null,
  };
}
