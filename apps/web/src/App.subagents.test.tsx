import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const subagent = {
  id: "subagent-1",
  parentThreadId: "thread-1",
  agentNickname: "Scout",
  agentRole: "explorer",
  status: "active",
  liveState: "streaming",
  updatedAt: 1777501300,
} as const;

const secondSubagent = {
  ...subagent,
  id: "subagent-2",
  agentNickname: "Builder",
  agentRole: "worker",
  status: "idle",
  liveState: "idle",
  updatedAt: 1777501400,
} as const;

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
    mockGateway(baseRoutes());

    render(<App />);

    expect(await screen.findByText(/hello from codex/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /show subagents/i })).not.toBeInTheDocument();
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

    await userEvent.click(await screen.findByRole("button", { name: /show subagents/i }));
    expect(await screen.findByText(/subagent snapshot/i)).toBeInTheDocument();

    let subagentStream: FakeEventSource | undefined;
    await waitFor(() => {
      subagentStream = FakeEventSource.instances.find(
        (instance) => instance.url.includes("threadId=subagent-1") && !instance.closed,
      );
      expect(subagentStream).toBeDefined();
    });

    act(() => {
      subagentStream?.emitNamed("timeline.projection_patch", projectionPatchEvent({
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
    let subagents = [subagent, secondSubagent];
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/subagents": () => ({ subagents }),
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

    subagents = [subagent, secondSubagent];
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    act(() => {
      globalStream?.emitNamed("timeline.item_upsert", {
        id: "main-collab-refresh",
        seq: 10,
        kind: "timeline.item_upsert",
        codexMethod: "item/upsert",
        projectId: project.id,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "collab-refresh",
        payload: {
          source: "gatewayStream",
          item: { id: "collab-refresh", type: "collabAgentToolCall", tool: "wait" },
        },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });
    await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads/thread-1/subagents").length).toBeGreaterThan(1));

    expect(screen.getByText(/builder snapshot/i)).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /builder/i })).toBeChecked();
  });

  it("falls back when the selected subagent disappears from the gateway list", async () => {
    let subagents = [subagent, secondSubagent];
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/threads/thread-1/subagents": () => ({ subagents }),
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

    subagents = [secondSubagent];
    const globalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    act(() => {
      globalStream?.emitNamed("timeline.item_upsert", {
        id: "main-collab-change",
        seq: 10,
        kind: "timeline.item_upsert",
        codexMethod: "item/upsert",
        projectId: project.id,
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "collab-1",
        payload: {
          source: "gatewayStream",
          item: { id: "collab-1", type: "collabAgentToolCall", tool: "wait" },
        },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });
    await waitFor(() => expect(gateway.callsFor("GET", "/v1/threads/thread-1/subagents").length).toBeGreaterThan(1));

    expect(await screen.findByText(/builder snapshot/i)).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /scout/i })).not.toBeInTheDocument();
  });
});
