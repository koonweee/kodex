import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";

import type { EventEnvelope, ThreadRead, ThreadViewResponse } from "../../api/client";
import { mockGateway } from "../../test/gatewayMock";
import { createMemoryWorkspacePaneStore } from "../../workspace/paneStore";
import { WorkspaceProvider, useWorkspace } from "../../workspace/WorkspaceProvider";
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

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); UnopenedEventSource.instances = []; });

it("does not acknowledge or advertise a pane hidden behind the narrow sidebar until the workspace is shown", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const current = snapshot("visible-terminal", 21);
  const gateway = mockGateway({
    "POST /v1/threads/deep-link/attach": current,
    "GET /v1/threads/deep-link/app-surface": { session: null },
    "POST /v1/threads/deep-link/seen": { ...current.thread, threadId: "deep-link", seenCompletedTurnId: "visible-terminal", readRevision: 22,
      unreadCompletedAgentTurn: false, updatedAt: "2026-10-05T00:00:00Z" },
  });
  const visibleThreads = vi.fn();
  const store = createMemoryWorkspacePaneStore({ schemaVersion: 1, activePaneId: "pane", dockviewLayout: null,
    panes: [{ id: "pane", kind: "thread", target: { mode: "existing", threadId: "deep-link" } }] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (isVisible: boolean) => <QueryClientProvider client={client}><MantineProvider>
    <WorkspaceProvider isVisible={isVisible} paneStore={store} onVisibleThreadIdsChange={visibleThreads}
      renderThreadComposer={(_pane, state) => <div role="status">{state.isReady ? "Canonical pane ready" : "Loading pane"}</div>}>
      <VisiblePane />
    </WorkspaceProvider>
  </MantineProvider></QueryClientProvider>;
  const view = render(tree(false));
  await screen.findByText("Canonical pane ready");
  expect(gateway.callsFor("POST", "/v1/threads/deep-link/seen")).toHaveLength(0);
  expect(visibleThreads).not.toHaveBeenCalledWith(["deep-link"]);
  view.rerender(tree(true));
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/deep-link/seen")).toHaveLength(1));
  expect(await gateway.callsFor("POST", "/v1/threads/deep-link/seen")[0].json()).toEqual({ completedTurnId: "visible-terminal", readRevision: 21 });
  expect(visibleThreads).toHaveBeenLastCalledWith(["deep-link"]);
});

it("refills an invalidated native head and acknowledges only the visible canonical completion after a stale attach", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const old = snapshot("turn-a", 10);
  const current = snapshot("turn-b", 12);
  let releaseOld!: (value: ThreadViewResponse) => void;
  const oldReply = new Promise<ThreadViewResponse>((resolve) => { releaseOld = resolve; });
  const signals: AbortSignal[] = [];
  const seen: ThreadRead = { ...current.thread, threadId: "deep-link", seenCompletedTurnId: "turn-b", unreadCompletedAgentTurn: false, readRevision: 13, updatedAt: "2026-10-05T00:00:00Z" };
  const gateway = mockGateway({
    "POST /v1/threads/deep-link/attach": (request: Request) => { signals.push(request.signal); return signals.length === 1 ? oldReply : current; },
    "POST /v1/threads/deep-link/seen": seen,
    "GET /v1/threads/deep-link/app-surface": { session: null },
  });
  const loaded = vi.fn();
  const store = createMemoryWorkspacePaneStore({ schemaVersion: 1, activePaneId: "pane", dockviewLayout: null,
    panes: [{ id: "pane", kind: "thread", target: { mode: "existing", threadId: "deep-link" } }] });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MantineProvider><WorkspaceProvider paneStore={store} onThreadSnapshotLoaded={loaded}
      renderThreadComposer={(_pane, state) => <div role="status">{state.thread?.latestCompletedTurnId}:{state.thread?.readRevision}:{String(state.thread?.unreadCompletedAgentTurn)}</div>}>
      <VisiblePane />
    </WorkspaceProvider></MantineProvider>
  </QueryClientProvider>);
  await waitFor(() => expect(signals).toHaveLength(1));
  const unknown: ThreadRead = { ...seen, latestCompletedTurnId: null, seenCompletedTurnId: "turn-a", readStateKnown: false, readRevision: 11 };
  act(() => UnopenedEventSource.instances.at(-1)!.emit({ id: "invalidated", seq: 50, kind: "thread.read_updated", threadId: "deep-link", payload: unknown, receivedAt: unknown.updatedAt }));
  await waitFor(() => expect(signals).toHaveLength(2));
  expect(signals[0].aborted).toBe(true);
  await waitFor(() => expect(gateway.callsFor("POST", "/v1/threads/deep-link/seen")).toHaveLength(1));
  expect(await gateway.callsFor("POST", "/v1/threads/deep-link/seen")[0].json()).toEqual({ completedTurnId: "turn-b", readRevision: 12 });
  expect(await screen.findByText("turn-b:13:false")).toBeInTheDocument();
  await act(async () => releaseOld(old));
  expect(screen.getByText("turn-b:13:false")).toBeInTheDocument();
  expect(loaded).not.toHaveBeenCalledWith(expect.objectContaining({ latestCompletedTurnId: "turn-a" }));
  expect(gateway.callsFor("POST", "/v1/threads/deep-link/seen")).toHaveLength(1);
});

function VisiblePane() {
  const { workspace, onVisiblePaneIdsChange } = useWorkspace();
  const pane = workspace?.panes[0];
  useEffect(() => { onVisiblePaneIdsChange(pane ? [pane.id] : []); }, [onVisiblePaneIdsChange, pane?.id]);
  return pane ? <ThreadPane isActive pane={pane} /> : null;
}

function snapshot(turnId: string, revision: number): ThreadViewResponse {
  return {
    thread: { id: "deep-link", name: "Unlisted chat", projectId: null, cwd: "/native", status: "idle", notificationsEnabled: true, pinned: false,
      latestCompletedTurnId: turnId, seenCompletedTurnId: null, readRevision: revision, readStateKnown: true, unreadCompletedAgentTurn: true,
      parentThreadId: null, canAcceptDirectInput: true, createdAt: 1, updatedAt: 2 },
    liveState: "idle", timeline: { liveState: "idle", activeTurnId: null, pendingApprovalRequests: [], pendingUserInputRequests: [],
      rows: [], turns: [{ id: turnId, status: "completed" }], viewRevision: revision },
  };
}
