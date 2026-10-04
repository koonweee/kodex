import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";

import type { ThreadViewResponse } from "../../api/client";
import { mockGateway } from "../../test/gatewayMock";
import { createMemoryWorkspacePaneStore } from "../../workspace/paneStore";
import { WorkspaceProvider, useWorkspace } from "../../workspace/WorkspaceProvider";
import { ThreadPane } from "./ThreadPane";

class UnopenedEventSource {
  onmessage = null;
  onerror = null;
  addEventListener() {}
  close() {}
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loads the canonical initial snapshot after StrictMode cleanup without waiting for the event stream", async () => {
  vi.stubGlobal("EventSource", UnopenedEventSource);
  const snapshot: ThreadViewResponse = {
    thread: {
      id: "thread-strict", name: "Canonical chat", projectId: "native-project", cwd: "/canonical",
      status: "idle", notificationsEnabled: true, seenCompletedAgentTurnSeq: 0,
      unreadCompletedAgentTurn: false, createdAt: 1, updatedAt: 2,
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

function ActiveThreadPane() {
  const { workspace } = useWorkspace();
  return <ThreadPane isActive pane={workspace.panes[0]} />;
}
