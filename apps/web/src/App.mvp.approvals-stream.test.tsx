import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Approval, ApprovalListResponse } from "./api/client";
import { App, FakeEventSource, baseRoutes, mockGateway, secondThread, thread, timelineElement } from "./test/mvpAppHarness";

function activeWorkspaceStream(threadId: string) {
  return [...FakeEventSource.instances].reverse().find((instance) => {
    const params = new URL(instance.url, window.location.origin).searchParams;
    return !instance.closed && params.get("includeGlobal") === "true"
      && (params.get("threadIds") ?? "").split(",").includes(threadId);
  });
}

const approval: Approval = {
  id: "native-approval", requestId: "native-request", source: "native", status: "pending",
  threadId: thread.id, turnId: "turn-1", itemId: "item-1",
  method: "item/commandExecution/requestApproval", payload: { command: "cargo test", cwd: "/home/example/kodex" },
  createdAt: "2026-10-04T00:00:00Z",
};
const snapshot = (revision: number, approvals: Approval[]): ApprovalListResponse => ({ runtimeId: "runtime-1", revision, approvals });
function changed(stream: FakeEventSource | undefined, seq: number) {
  stream?.emit({ id: `event-${seq}`, seq, kind: "approval.changed", payload: { runtimeId: "runtime-1" }, receivedAt: "2026-10-04T00:00:00Z" });
}

describe("authoritative approval stream flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("keeps a submitted decision disabled until an invalidation reads native resolution", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let current = snapshot(1, [approval]);
    const responding = { ...approval, status: "responding" };
    const gateway = mockGateway(baseRoutes({
      "GET /v1/approvals": () => current,
      "POST /v1/approvals/native-approval/decision": () => { current = snapshot(2, [responding]); return responding; },
    }));
    const { container } = render(<App />);
    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = timelineElement(container);
    const proceed = await within(timeline).findByRole("button", { name: "Yes, proceed" });
    await userEvent.click(proceed);
    await waitFor(() => expect(proceed).toBeDisabled());
    expect(within(timeline).getByText(/cargo test/i)).toBeInTheDocument();
    expect(gateway.callsFor("POST", "/v1/approvals/native-approval/decision")).toHaveLength(1);

    await waitFor(() => expect(activeWorkspaceStream(thread.id)).toBeDefined());
    current = snapshot(3, []);
    act(() => changed(activeWorkspaceStream(thread.id), 3));
    await waitFor(() => expect(within(timeline).queryByText(/cargo test/i)).not.toBeInTheDocument());
    act(() => activeWorkspaceStream(thread.id)?.emit({ id: "old-row", seq: 4, kind: "approval.created", payload: approval }));
    expect(within(timeline).queryByText(/cargo test/i)).not.toBeInTheDocument();
  });

  it("updates a non-selected chat's badge and card from the global native snapshot", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    let current = snapshot(1, []);
    const otherApproval = { ...approval, threadId: secondThread.id, payload: { command: "cargo fmt" } };
    mockGateway(baseRoutes({
      "GET /v1/threads": { threads: [thread, secondThread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
      "GET /v1/approvals": () => current,
    }));
    render(<App />);
    const secondThreadButton = await screen.findByRole("button", { name: /second thread/i });
    await waitFor(() => expect(activeWorkspaceStream(thread.id)).toBeDefined());
    current = snapshot(2, [otherApproval]);
    act(() => changed(activeWorkspaceStream(thread.id), 2));
    expect(await within(secondThreadButton).findByText(/needs approval/i)).toBeInTheDocument();
    await userEvent.click(secondThreadButton);
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/cargo fmt/i)).toBeInTheDocument();
    await waitFor(() => expect(activeWorkspaceStream(secondThread.id)).toBeDefined());
    current = snapshot(3, []);
    act(() => changed(activeWorkspaceStream(secondThread.id), 3));
    await waitFor(() => {
      expect(within(timeline).queryByText(/cargo fmt/i)).not.toBeInTheDocument();
      expect(within(secondThreadButton).queryByText(/needs approval/i)).not.toBeInTheDocument();
    });
  });
});
