import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ThreadSubagentSummary } from "./api/client";
import {
  App,
  FakeEventSource,
  baseRoutes,
  mockGateway,
  project,
  projectionPatchEvent,
  snapshotItem,
  snapshotTurn,
  thread,
  threadDetail,
} from "./test/mvpAppHarness";

const subagent: ThreadSubagentSummary = {
  id: "subagent-1",
  parentThreadId: "thread-1",
  agentNickname: "Scout",
  agentRole: "explorer",
  status: "active",
  liveState: "streaming",
  updatedAt: 1777501300,
};

const secondSubagent: ThreadSubagentSummary = {
  ...subagent,
  id: "subagent-2",
  agentNickname: "Builder",
  agentRole: "worker",
  status: "idle",
  liveState: "idle",
  updatedAt: 1777501400,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function streamIncludesThread(instance: FakeEventSource, threadId: string): boolean {
  const url = new URL(instance.url, "http://localhost");
  return (url.searchParams.get("threadIds") ?? "").split(",").includes(threadId);
}

const subagentThread = {
  ...thread,
  id: "subagent-1",
  name: "Scout",
  status: "active",
  agentNickname: "Scout",
  agentRole: "explorer",
};

describe("subagent thread viewer", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("hides the robot action when the gateway reports no subagents", async () => {
    window.history.replaceState(null, "", "/threads/thread-1");
    mockGateway(baseRoutes());

    render(<App />);

    expect(await screen.findByRole("navigation", { name: /workspace/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show subagents/i })).not.toBeInTheDocument();
  });

  it("waits for the selected thread snapshot before discovering subagents", async () => {
    const detailDeferred = deferred<ReturnType<typeof threadDetail>>();
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1": () => detailDeferred.promise,
        "GET /v1/threads/thread-1/subagents": { subagents: [subagent] },
      }),
    );

    render(<App />);

    expect(await screen.findByRole("button", { name: /implement frontend/i })).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(gateway.callsFor("GET", "/v1/threads/thread-1/subagents")).toHaveLength(0);

    await act(async () => {
      detailDeferred.resolve(threadDetail(thread, [
        snapshotTurn("turn-1", [
          snapshotItem("answer-1", "agentMessage", { text: "Main thread snapshot" }),
        ]),
      ]));
      await detailDeferred.promise;
    });

    expect(await screen.findByText(/main thread snapshot/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(gateway.callsFor("GET", "/v1/threads/thread-1/subagents")).toHaveLength(1);
    });
  });

  it("opens a read-only subagent sidebar without resuming or switching the active thread", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/subagents": { subagents: [subagent] },
        "GET /v1/threads/subagent-1": threadDetail(subagentThread, [
          snapshotTurn("sub-turn-1", [
            snapshotItem("sub-answer-1", "agentMessage", { text: "Subagent snapshot" }),
          ]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/hello from codex/i)).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /subagent thread viewer/i })).not.toBeInTheDocument();

    await userEvent.click(await screen.findByRole("button", { name: /show subagents/i }));

    const viewer = await screen.findByRole("complementary", { name: /subagent thread viewer/i });
    expect(within(viewer).getByText(/scout \[explorer\]/i)).toBeInTheDocument();
    expect(await within(viewer).findByText(/subagent snapshot/i)).toBeInTheDocument();
    expect(screen.getByText(/hello from codex/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /thread actions/i })).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/subagent-1")).toHaveLength(1);
    expect(gateway.callsFor("POST", "/v1/threads/subagent-1/resume")).toHaveLength(0);
    expect(within(viewer).queryByRole("button", { name: /approve|deny|allow/i })).not.toBeInTheDocument();
  });

  it("streams live updates into the selected subagent viewer only", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/subagents": { subagents: [subagent] },
        "GET /v1/threads/subagent-1": threadDetail(subagentThread, [
          snapshotTurn("sub-turn-1", [
            snapshotItem("sub-answer-1", "agentMessage", { text: "Subagent snapshot" }),
          ]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/hello from codex/i)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /show subagents/i }, { timeout: 5000 }));
    expect(await screen.findByText(/subagent snapshot/i)).toBeInTheDocument();

    let subagentStream: FakeEventSource | undefined;
    await waitFor(() => {
      subagentStream = FakeEventSource.instances.find(
        (instance) => instance.url.includes("threadId=subagent-1") && !instance.closed,
      );
      expect(subagentStream).toBeDefined();
    });

    act(() => {
      subagentStream?.emitNamed("thread_view.patch", projectionPatchEvent({
        id: "subagent-live-event",
        seq: 9,
        projectId: project.id,
        threadId: "subagent-1",
        turnId: "sub-turn-2",
        itemId: "sub-live-answer",
        text: "Subagent live update",
        displayOrder: 9,
      }));
    });

    const viewer = await screen.findByRole("complementary", { name: /subagent thread viewer/i });
    expect(await within(viewer).findByText(/subagent live update/i)).toBeInTheDocument();
    expect(screen.queryAllByText(/subagent live update/i)).toHaveLength(1);
  });

  it("preserves manual selection while that subagent remains available", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/subagents": { subagents: [subagent, secondSubagent] },
        "GET /v1/threads/subagent-1": threadDetail(subagentThread, [
          snapshotTurn("sub-turn-1", [
            snapshotItem("sub-answer-1", "agentMessage", { text: "Scout snapshot" }),
          ]),
        ]),
        "GET /v1/threads/subagent-2": threadDetail(
          { ...thread, id: "subagent-2", name: "Builder", agentNickname: "Builder", agentRole: "worker" },
          [
            snapshotTurn("sub-turn-1", [
              snapshotItem("sub-answer-1", "agentMessage", { text: "Builder snapshot" }),
            ]),
          ],
        ),
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /show subagents/i }));
    await userEvent.click(await screen.findByRole("radio", { name: /builder/i }));
    expect(await screen.findByText(/builder snapshot/i)).toBeInTheDocument();

    const selectedThreadStream = FakeEventSource.instances.find((instance) => streamIncludesThread(instance, "thread-1"));
    act(() => {
      selectedThreadStream?.emitNamed("thread.subagent_updated", subagentDiscoveryEvent({
        id: "subagent-update",
        seq: 10,
        subagent: { ...secondSubagent, status: "active", liveState: "streaming", updatedAt: 1777501500 },
      }));
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(screen.getByText(/builder snapshot/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /builder/i })).toBeChecked();
    expect(gateway.callsFor("GET", "/v1/threads/thread-1/subagents")).toHaveLength(1);
  });

  it("does not refetch subagents for selected-thread streaming patches", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/subagents": { subagents: [subagent] },
        "GET /v1/threads/subagent-1": threadDetail(subagentThread, [
          snapshotTurn("sub-turn-1", [
            snapshotItem("sub-answer-1", "agentMessage", { text: "Subagent snapshot" }),
          ]),
        ]),
      }),
    );

    render(<App />);

    await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads/thread-1/subagents")).toHaveLength(1));
    const selectedThreadStream = FakeEventSource.instances.find((instance) => streamIncludesThread(instance, "thread-1"));
    act(() => {
      selectedThreadStream?.emitNamed("thread_view.patch", projectionPatchEvent({
        id: "main-ordinary-streaming-patch",
        seq: 10,
        projectId: project.id,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "collab-agent-message",
        itemType: "collabAgentToolCall",
        text: "Collab agent output is not a discovery signal",
      }));
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(gateway.callsFor("GET", "/v1/threads/thread-1/subagents")).toHaveLength(1);
  });

  it("does not refetch sidebar thread lists for background subagent timeline patches", async () => {
    const gateway = mockGateway(baseRoutes());

    render(<App />);

    expect(await screen.findByText(/hello from codex/i)).toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads")).toHaveLength(0);
    expect(gateway.callsFor("GET", "/v1/chats/threads")).toHaveLength(0);

    const globalStream = FakeEventSource.instances.find((instance) => instance.url.includes("includeGlobal=true"));
    act(() => {
      globalStream?.emitNamed("thread_view.patch", projectionPatchEvent({
        id: "background-subagent-patch",
        seq: 10,
        projectId: null,
        threadId: "subagent-1",
        turnId: "sub-turn-1",
        itemId: "subagent-output",
        text: "Background subagent output",
      }));
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(gateway.callsFor("GET", "/v1/threads")).toHaveLength(0);
    expect(gateway.callsFor("GET", "/v1/chats/threads")).toHaveLength(0);
  });

  it("falls back when the selected subagent disappears from the gateway list", async () => {
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/subagents": { subagents: [subagent, secondSubagent] },
        "GET /v1/threads/subagent-1": threadDetail(subagentThread, [
          snapshotTurn("sub-turn-1", [
            snapshotItem("sub-answer-1", "agentMessage", { text: "Scout snapshot" }),
          ]),
        ]),
        "GET /v1/threads/subagent-2": threadDetail(
          { ...thread, id: "subagent-2", name: "Builder", agentNickname: "Builder", agentRole: "worker" },
          [
            snapshotTurn("sub-turn-1", [
              snapshotItem("sub-answer-1", "agentMessage", { text: "Builder snapshot" }),
            ]),
          ],
        ),
      }),
    );

    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: /show subagents/i }));
    expect(await screen.findByText(/scout snapshot/i)).toBeInTheDocument();

    const selectedThreadStream = FakeEventSource.instances.find((instance) => streamIncludesThread(instance, "thread-1"));
    act(() => {
      selectedThreadStream?.emitNamed("thread.subagent_stopped", subagentDiscoveryEvent({
        id: "subagent-stop",
        kind: "thread.subagent_stopped",
        seq: 10,
        subagentId: "subagent-1",
        subagent: null,
      }));
    });

    expect(await screen.findByText(/builder snapshot/i)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /scout/i })).not.toBeInTheDocument();
    expect(gateway.callsFor("GET", "/v1/threads/thread-1/subagents")).toHaveLength(1);
  });

  it("shows the subagent action when a parent-scoped start event arrives", async () => {
    mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/subagents": { subagents: [] },
        "GET /v1/threads/subagent-1": threadDetail(subagentThread, [
          snapshotTurn("sub-turn-1", [
            snapshotItem("sub-answer-1", "agentMessage", { text: "Subagent snapshot" }),
          ]),
        ]),
      }),
    );

    render(<App />);

    expect(await screen.findByText(/hello from codex/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show subagents/i })).not.toBeInTheDocument();

    const selectedThreadStream = FakeEventSource.instances.find((instance) => streamIncludesThread(instance, "thread-1"));
    act(() => {
      selectedThreadStream?.emitNamed("thread.subagent_started", subagentDiscoveryEvent({
        id: "subagent-start",
        kind: "thread.subagent_started",
        seq: 10,
        subagent,
      }));
    });

    await userEvent.click(await screen.findByRole("button", { name: /show subagents/i }));
    expect(await screen.findByText(/subagent snapshot/i)).toBeInTheDocument();
  });
});

function subagentDiscoveryEvent({
  id,
  kind = "thread.subagent_updated",
  seq,
  subagent: payloadSubagent = subagent,
  subagentId = payloadSubagent?.id ?? null,
}: {
  id: string;
  kind?: "thread.subagent_started" | "thread.subagent_updated" | "thread.subagent_stopped";
  seq: number;
  subagent?: typeof subagent | typeof secondSubagent | null;
  subagentId?: string | null;
}) {
  return {
    id,
    seq,
    kind,
    codexMethod: "thread/subagent",
    projectId: project.id,
    threadId: "thread-1",
    turnId: null,
    itemId: null,
    payload: {
      parentThreadId: "thread-1",
      subagentId,
      subagent: payloadSubagent,
    },
    receivedAt: "2026-05-31T00:00:00Z",
  };
}
