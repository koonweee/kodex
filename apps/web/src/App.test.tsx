import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { mockGateway } from "./test/gatewayMock";

describe("App shell", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the MVP shell with debug menu in the sidebar footer", async () => {
    mockGateway({
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    expect(screen.queryByRole("banner", { name: /kodex/i })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: /workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("main", { name: /thread/i })).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /approvals/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/message composer/i)).toBeDisabled();

    expect(screen.queryByRole("button", { name: /status/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /debug options/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /account settings/i }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /show debug events/i })).toBeInTheDocument();
    expect(screen.queryByText(/gateway/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/app-server/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/trusted network/i)).not.toBeInTheDocument();
  });

  it("keeps the shell visible when optional app-server-backed calls fail", async () => {
    mockGateway({
      "GET /v1/projects": { projects: [] },
    });

    render(<App />);

    expect(await screen.findByRole("navigation", { name: /workspace/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /account settings/i })).toBeInTheDocument();
  });

  it("lets the workspace sidebar grow wider from its minimum width", async () => {
    mockGateway({
      "GET /v1/projects": { projects: [] },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    const resizeHandle = screen.getByRole("separator", { name: /resize workspace sidebar/i });
    expect(resizeHandle).toHaveAttribute("aria-valuenow", "292");

    fireEvent.pointerDown(resizeHandle, { clientX: 292, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 420, pointerId: 1 });
    fireEvent.pointerUp(window, { pointerId: 1 });

    expect(resizeHandle).toHaveAttribute("aria-valuenow", "420");
    expect(screen.getByRole("navigation", { name: /workspace/i })).toHaveStyle({ width: "420px" });
  });

  it("keeps the thread header and composer outside the timeline scroll region and toggles debug events locally", async () => {
    mockGateway({
      "GET /v1/projects": {
        projects: [{ id: "project-1", name: "Kodex", cwd: "/home/example/kodex", createdAt: "", updatedAt: "" }],
      },
      "GET /v1/threads": {
        threads: [
          {
            id: "thread-1",
            name: "Investigate timeline rendering with a deliberately long generated title",
            cwd: "/home/example/kodex",
            status: "idle",
            source: "local",
            preview: "",
            rawPayload: {},
            createdAt: 1777500000,
            updatedAt: 1777501200,
          },
        ],
        nextCursor: null,
        backwardsCursor: null,
        rawPayload: {},
      },
      "GET /v1/events": {
        events: [
          {
            id: "event-1",
            seq: 1,
            kind: "codex.notification",
            codexMethod: "turn/started",
            projectId: "project-1",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: null,
            payload: { status: "running" },
            receivedAt: "2026-04-30T00:00:00Z",
          },
          {
            id: "event-2",
            seq: 2,
            kind: "codex.notification",
            codexMethod: "item/completed",
            projectId: "project-1",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "answer-1",
            payload: { item: { id: "answer-1", type: "agentMessage", text: "Visible answer" } },
            receivedAt: "2026-04-30T00:00:01Z",
          },
        ],
      },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    });

    render(<App />);

    const thread = await screen.findByRole("main", { name: /thread/i });
    expect(await within(thread).findByText(/visible answer/i)).toBeInTheDocument();
    expect(thread.querySelector(".kodex-thread-header")).toBeInTheDocument();
    expect(thread.querySelector(".kodex-timeline-scroll")).toBeInTheDocument();
    expect(thread.querySelector(".kodex-composer")).toBeInTheDocument();
    expect(within(thread).queryByText(/event stream/i)).not.toBeInTheDocument();
    expect(within(thread).queryByText(/turn\/started/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /account settings/i }));
    await userEvent.click(await screen.findByRole("menuitemcheckbox", { name: /show debug events/i }));

    expect(await within(thread).findAllByText(/turn\/started/i)).not.toHaveLength(0);
    expect(within(thread).getByText(/"status": "running"/i)).toBeInTheDocument();
  });
});
