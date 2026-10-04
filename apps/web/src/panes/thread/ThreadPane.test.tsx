import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import type { EventEnvelope, ThreadSummary, ThreadViewResponse } from "../../api/client";
import { mockGateway } from "../../test/gatewayMock";
import { createMemoryWorkspacePaneStore } from "../../workspace/paneStore";
import { WorkspaceProvider, useWorkspace } from "../../workspace/WorkspaceProvider";
import { ThreadPane } from "./ThreadPane";

class UnopenedEventSource {
  static instances: UnopenedEventSource[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror = null;
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

it("loads the canonical initial snapshot after StrictMode cleanup without waiting for the event stream", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const snapshot: ThreadViewResponse = {
    thread: {
      id: "thread-strict", name: "Canonical chat", projectId: "native-project", cwd: "/canonical",
      status: "idle", notificationsEnabled: true, seenCompletedAgentTurnSeq: 0,
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
    "GET /v1/threads/thread-strict": (request: Request) => {
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
  expect(signals[0].aborted).toBe(true);
  expect(onLoaded).toHaveBeenCalledTimes(1);
  expect(onLoaded).toHaveBeenCalledWith(expect.objectContaining({ projectId: "native-project", cwd: "/canonical" }));
  await act(async () => { releaseAborted({ ...snapshot, thread: { ...snapshot.thread, name: "Obsolete chat", projectId: null } }); });
  await waitFor(() => expect(screen.getByRole("heading", { name: "Canonical chat" })).toBeInTheDocument());
  expect(onLoaded).toHaveBeenCalledTimes(1);
  expect(onFailed).not.toHaveBeenCalled();
});

it("keeps direct-input capability owned by canonical detail when older sidebar and metadata summaries arrive", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const seed: ThreadSummary = {
    id: "child", parentThreadId: "parent", canAcceptDirectInput: null, name: "Child", cwd: "/native",
    projectId: null, status: "idle", notificationsEnabled: true, seenCompletedAgentTurnSeq: 0,
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
    "GET /v1/threads/child": (request: Request) => { signals.push(request.signal); return signals.length === 1 ? initialReply : detail; },
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
  view.rerender(tree({ ...seed, name: "List rename" }));
  expect(screen.getByText("Native input: false")).toBeInTheDocument();

  detail = { ...detail, thread: { ...detail.thread, canAcceptDirectInput: true } };
  act(() => source.emit({ id: "native-change", seq: 2, kind: "thread.subagents_changed", payload: { changedThreadId: "child" }, receivedAt: "2026-10-04T00:00:00Z" }));
  expect(await screen.findByText("Native input: true")).toBeInTheDocument();
  expect(gateway.callsFor("GET", "/v1/threads/child")).toHaveLength(2);
  act(() => source.emit({ id: "old-metadata", seq: 3, threadId: "child", kind: "timeline.thread_metadata", payload: { thread: { ...seed, canAcceptDirectInput: false } }, receivedAt: "2026-10-04T00:00:00Z" }));
  expect(screen.getByText("Native input: true")).toBeInTheDocument();
});

function ActiveThreadPane() {
  const { workspace } = useWorkspace();
  return <ThreadPane isActive pane={workspace.panes[0]} />;
}
