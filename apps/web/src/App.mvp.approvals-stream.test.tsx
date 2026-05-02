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

describe("MVP approvals stream flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("does not resurrect a locally resolved approval from a stale created event", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const approval = {
      id: "approval-local-resolution",
      requestId: "request-local-resolution",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo test", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [approval] },
        "POST /v1/approvals/approval-local-resolution/decision": {
          ...approval,
          status: "resolved",
          response: { decision: "accept" },
          resolvedAt: "2026-04-30T00:00:01Z",
        },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/cargo test/i)).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    await userEvent.click(within(timeline).getByRole("button", { name: /yes, proceed/i }));
    await waitFor(() => {
      expect(within(timeline).queryByText(/cargo test/i)).not.toBeInTheDocument();
    });

    act(() => {
      globalApprovalStream?.emit({
        id: "event-stale-local-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: approval,
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(within(timeline).queryByText(/cargo test/i)).not.toBeInTheDocument();
  });

  it("applies approval created and resolved events from the stream", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const gateway = mockGateway(baseRoutes());
    const streamedApproval = {
      id: "approval-streamed",
      requestId: "request-streamed",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "npm test", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    let selectedThreadStream: FakeEventSource | undefined;
    await waitFor(() => {
      selectedThreadStream = FakeEventSource.instances.find((instance) => instance.url.includes("threadId=thread-1"));
      expect(selectedThreadStream).toBeDefined();
    });
    act(() => {
      selectedThreadStream?.emit({
        id: "event-approval-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: streamedApproval,
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    expect(await within(timeline).findByText(/npm test/i)).toBeInTheDocument();

    act(() => {
      selectedThreadStream?.emit({
        id: "event-approval-resolved",
        seq: 3,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: { ...streamedApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    await waitFor(() => {
      expect(within(timeline).queryByText(/npm test/i)).not.toBeInTheDocument();
    });
    expect(gateway.callsFor("GET", "/v1/events")).toHaveLength(0);
  });

  it("keeps non-selected thread approval badges in sync", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
      }),
    );
    const streamedApproval = {
      id: "approval-other-thread",
      requestId: "request-other-thread",
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo fmt", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-other-approval-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: streamedApproval,
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });
    expect(await within(secondThreadButton).findByText(/needs approval/i)).toBeInTheDocument();

    await userEvent.click(secondThreadButton);
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/cargo fmt/i)).toBeInTheDocument();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-other-approval-resolved",
        seq: 3,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: { ...streamedApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });
    await waitFor(() => {
      expect(within(timeline).queryByText(/cargo fmt/i)).not.toBeInTheDocument();
      expect(within(secondThreadButton).queryByText(/needs approval/i)).not.toBeInTheDocument();
    });
  });

  it("does not drop streamed approvals when the initial pending approval request resolves later", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveApprovals: (value: unknown) => void = () => undefined;
    const delayedApprovals = new Promise((resolve) => {
      resolveApprovals = resolve;
    });
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/approvals": () => delayedApprovals,
      }),
    );
    const streamedApproval = {
      id: "approval-before-load",
      requestId: "request-before-load",
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "npm run build", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-before-load-created",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: streamedApproval,
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });
    expect(await within(secondThreadButton).findByText(/needs approval/i)).toBeInTheDocument();

    await userEvent.click(secondThreadButton);
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/npm run build/i)).toBeInTheDocument();

    await act(async () => {
      resolveApprovals({ approvals: [] });
      await Promise.resolve();
    });
    expect(within(timeline).getByText(/npm run build/i)).toBeInTheDocument();
  });

  it("does not resurrect a resolved approval from a late stale pending approval response", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let resolveApprovals: (value: unknown) => void = () => undefined;
    const delayedApprovals = new Promise((resolve) => {
      resolveApprovals = resolve;
    });
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, secondThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/approvals": () => delayedApprovals,
      }),
    );
    const staleApproval = {
      id: "approval-resolved-before-load",
      requestId: "request-resolved-before-load",
      threadId: "thread-2",
      turnId: "turn-2",
      itemId: "item-2",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "npm test", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-before-load-resolved",
        seq: 2,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "item-2",
        payload: { ...staleApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:01Z",
      });
    });

    await act(async () => {
      resolveApprovals({ approvals: [staleApproval] });
      await Promise.resolve();
    });
    expect(within(secondThreadButton).queryByText(/needs approval/i)).not.toBeInTheDocument();
  });

  it("does not resurrect a resolved approval from a later stale created event", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    mockGateway(baseRoutes());
    const staleApproval = {
      id: "approval-resolved-before-created-replay",
      requestId: "request-resolved-before-created-replay",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo clippy", cwd: "/home/example/kodex" },
      response: null,
      createdAt: "2026-04-30T00:00:01Z",
      resolvedAt: null,
    };

    render(<App />);

    const timeline = await screen.findByRole("main", { name: /thread/i });
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(1));
    const globalApprovalStream = FakeEventSource.instances.find((instance) => !instance.url.includes("threadId="));
    expect(globalApprovalStream).toBeDefined();

    act(() => {
      globalApprovalStream?.emit({
        id: "event-resolved-before-created-replay",
        seq: 3,
        kind: "approval.resolved",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: { ...staleApproval, status: "resolved", response: { decision: "accept" } },
        receivedAt: "2026-04-30T00:00:03Z",
      });
      globalApprovalStream?.emit({
        id: "event-created-after-resolved-replay",
        seq: 2,
        kind: "approval.created",
        codexMethod: null,
        projectId: project.id,
        threadId: thread.id,
        turnId: "turn-1",
        itemId: "item-1",
        payload: staleApproval,
        receivedAt: "2026-04-30T00:00:02Z",
      });
    });

    expect(within(timeline).queryByText(/cargo clippy/i)).not.toBeInTheDocument();
  });

});
