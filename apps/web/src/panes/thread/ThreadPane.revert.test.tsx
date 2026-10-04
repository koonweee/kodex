import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { EventEnvelope, ThreadTimelineRow, ThreadViewResponse } from "../../api/client";
import { mockGateway } from "../../test/gatewayMock";
import { createMemoryWorkspacePaneStore } from "../../workspace/paneStore";
import { WorkspaceProvider, useWorkspace } from "../../workspace/WorkspaceProvider";
import { ThreadPane } from "./ThreadPane";

class EventSourceFixture {
  static instances: EventSourceFixture[] = [];
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  constructor() { EventSourceFixture.instances.push(this); }
  addEventListener() {}
  close() {}
  emit(event: EventEnvelope) { this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>); }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  EventSourceFixture.instances = [];
});

it.each(["snapshot", "older page"])("fences a pending %s read when native revert resets the canonical window", async (pendingRead) => {
  vi.stubGlobal("EventSource", EventSourceFixture);
  let current = snapshot([row("kept", 1), row("removed", 2)], 2);
  current.timeline.activeTurnId = "turn-removed";
  current.timeline.liveState = "streaming";
  const obsolete = structuredClone(current);
  obsolete.thread.name = "Obsolete before revert";
  let release!: (value: ThreadViewResponse) => void;
  const pending = new Promise<ThreadViewResponse>((resolve) => { release = resolve; });
  let releaseRefill!: (value: ThreadViewResponse) => void;
  const refill = new Promise<ThreadViewResponse>((resolve) => { releaseRefill = resolve; });
  let holdNextAttach = false;
  let holdRefill = false;
  let refillRequested = false;
  let heldSignal: AbortSignal | undefined;
  const gateway = mockGateway({
    "POST /v1/threads/revert-chat/attach": (request: Request) => {
      if (holdRefill) { refillRequested = true; return refill; }
      if (!holdNextAttach) return current;
      holdNextAttach = false;
      heldSignal = request.signal;
      return pending;
    },
    "GET /v1/threads/revert-chat/timeline/pages": (request: Request) => {
      expect(new URL(request.url).searchParams.get("cursor")).toBe("opaque-before");
      heldSignal = request.signal;
      return pending;
    },
    "GET /v1/threads/revert-chat/app-surface": { session: null },
  });
  const loaded = vi.fn();
  const failed = vi.fn();
  const store = createMemoryWorkspacePaneStore({
    schemaVersion: 1, activePaneId: "revert-pane", dockviewLayout: null,
    panes: [{ id: "revert-pane", kind: "thread", target: { mode: "existing", threadId: "revert-chat" } }],
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MantineProvider><WorkspaceProvider paneStore={store} onThreadSnapshotLoaded={loaded} onThreadSnapshotLoadFailed={failed}
      renderThreadComposer={(_pane, state) => <div role="status">{state.activeTurnId ? `Active turn: ${state.activeTurnId}` : "No active turn"}</div>}>
      <ActivePane />
    </WorkspaceProvider></MantineProvider>
  </QueryClientProvider>);
  expect(await screen.findByText("Native removed history")).toBeVisible();
  expect(screen.getByText("Active turn: turn-removed")).toBeVisible();
  const stream = EventSourceFixture.instances.at(-1)!;
  if (pendingRead === "snapshot") {
    holdNextAttach = true;
    act(() => stream.emit(marker(3, "snapshot_required")));
  } else {
    fireEvent.click(screen.getByRole("button", { name: "Load older history" }));
  }
  await waitFor(() => expect(heldSignal).toBeDefined());
  expect(heldSignal?.aborted).toBe(false);

  current = snapshot([row("kept", 1)], 5);
  current.historyPage = { ...current.historyPage!, olderCursor: null, hasOlder: false, loadedTurnCount: 1 };
  holdRefill = true;
  act(() => {
    stream.emit({ ...marker(4, "thread_reverted"), kind: "thread_view.patch", payload: {
      ...snapshot([], 4).timeline, scope: "full_snapshot", threadId: "revert-chat", affectedTurnIds: [],
    } });
    stream.emit(marker(4, "thread_reverted"));
  });
  await waitFor(() => expect(heldSignal?.aborted).toBe(true));
  await waitFor(() => expect(refillRequested).toBe(true));
  await waitFor(() => expect(screen.queryByText("Native removed history")).not.toBeInTheDocument());
  expect(screen.queryByText("Native kept history")).not.toBeInTheDocument();
  expect(screen.getByText("No active turn")).toBeVisible();
  await act(async () => { release(obsolete); await pending; });
  expect(screen.queryByText("Native removed history")).not.toBeInTheDocument();
  expect(screen.queryByText("Native kept history")).not.toBeInTheDocument();
  await act(async () => { releaseRefill(current); await refill; });
  expect(screen.getByText("Native kept history")).toBeVisible();
  expect(screen.queryByText("Native removed history")).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Obsolete before revert" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Load older history" })).not.toBeInTheDocument();
  expect(loaded).toHaveBeenCalledTimes(2);
  expect(failed).not.toHaveBeenCalled();
  expect(gateway.callsFor("GET", "/v1/threads/revert-chat")).toHaveLength(0);
});

function ActivePane() {
  const { workspace } = useWorkspace();
  return <ThreadPane isActive pane={workspace.panes[0]} />;
}

function snapshot(rows: ThreadTimelineRow[], viewRevision: number): ThreadViewResponse {
  return {
    thread: { id: "revert-chat", name: "Native history", projectId: null, cwd: "/native", status: "idle", parentThreadId: null, canAcceptDirectInput: true, notificationsEnabled: true, seenCompletedAgentTurnSeq: 0, unreadCompletedAgentTurn: false, createdAt: 1, updatedAt: 2 },
    liveState: "idle",
    historyPage: { olderCursor: "opaque-before", newerCursor: null, hasOlder: true, limit: 50, loadedTurnCount: rows.length, resetWindow: false },
    timeline: { liveState: "idle", activeTurnId: null, pendingApprovalRequests: [], pendingUserInputRequests: [], rows, turns: rows.map((entry) => ({ id: entry.turnId!, status: "completed" })), viewRevision },
  };
}

function row(id: string, displayOrder: number): ThreadTimelineRow {
  const turnId = `turn-${id}`;
  return {
    id, turnId, kind: "user_message", status: "completed", displayOrder, items: [], collapsedRows: [], fileChanges: [],
    item: { id, threadId: "revert-chat", turnId, itemId: id, itemType: "userMessage", status: "completed", displayOrder, codexMethod: "item/completed", payload: {
      source: "appServerSnapshot", turnId, itemId: id, itemSnapshot: { id, itemType: "userMessage" },
      item: { id, type: "userMessage", content: [{ type: "text", text: `Native ${id} history` }] },
    } },
  };
}

function marker(seq: number, reason: string): EventEnvelope {
  return { id: `event-${seq}`, seq, kind: "thread_view.refresh_required", threadId: "revert-chat", payload: { threadId: "revert-chat", reason }, receivedAt: "2026-10-05T00:00:00Z" };
}
