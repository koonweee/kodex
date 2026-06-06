import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  App,
  FakeEventSource,
  appCss,
  baseRoutes,
  mockGateway,
  project,
  requestJson,
  secondThread,
  snapshotItem,
  snapshotTurn,
  thread,
  threadDetail,
} from "./test/mvpAppHarness";

describe("MVP approvals UI flows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("marks threads that need approval and renders their approvals inside the thread", async () => {
    const blockedThread = {
      ...secondThread,
      status: "waitingOnApproval",
    };
    const unanchoredApproval = {
      id: "approval-thread-owned",
      requestId: "request-thread-owned",
      threadId: blockedThread.id,
      turnId: "turn-2",
      itemId: "missing-item",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo test", cwd: "/home/example/kodex", reason: "Verify changes" },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [thread, blockedThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/approvals": { approvals: [unanchoredApproval] },
        "GET /v1/events": {
          events: [
            {
              id: "event-second-thread-message",
              seq: 1,
              kind: "codex",
              codexMethod: "item/agentMessage/delta",
              projectId: project.id,
              threadId: blockedThread.id,
              turnId: "turn-2",
              itemId: "item-visible",
              payload: { delta: "Waiting for approval" },
              receivedAt: "2026-04-30T00:00:00Z",
            },
          ],
        },
        "GET /v1/threads/thread-2": threadDetail(blockedThread, [
          snapshotTurn("turn-2", [
            snapshotItem("item-visible", "agentMessage", {
              phase: "commentary",
              text: "Waiting for approval",
            }),
          ]),
        ]),
      }),
    );

    render(<App />);

    const blockedThreadButton = await screen.findByRole("button", { name: /second thread/i });
    expect(within(blockedThreadButton).getByText(/needs approval/i)).toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: /approvals/i })).not.toBeInTheDocument();

    await userEvent.click(blockedThreadButton);

    const threadView = await screen.findByRole("main", { name: /thread/i });
    const visibleHistory = await within(threadView).findByText(/waiting for approval/i);
    const approvalCard = await within(threadView).findByText(/cargo test/i);
    expect(Boolean(visibleHistory.compareDocumentPosition(approvalCard) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(within(threadView).getByText(/reason: verify changes/i)).toBeInTheDocument();
  });

  it("keeps the route-selected thread when initial pending approvals reorder loaded threads", async () => {
    let resolveApprovals: (value: unknown) => void = () => undefined;
    const delayedApprovals = new Promise((resolve) => {
      resolveApprovals = resolve;
    });
    const recentIdleThread = {
      ...thread,
      id: "thread-recent-idle",
      name: "Recent idle thread",
      updatedAt: 1777503000,
    };
    const olderApprovalThread = {
      ...secondThread,
      id: "thread-older-approval",
      name: "Older approval thread",
      updatedAt: 1777500000,
    };
    const approval = {
      id: "approval-initial-reorder",
      requestId: "request-initial-reorder",
      threadId: olderApprovalThread.id,
      turnId: "turn-older",
      itemId: "item-older",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo test", cwd: "/home/example/kodex", reason: "Verify before continuing" },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    window.history.replaceState(null, "", "/threads/thread-recent-idle");
    mockGateway(
      baseRoutes({
        "GET /v1/threads": {
          threads: [recentIdleThread, olderApprovalThread],
          nextCursor: null,
          backwardsCursor: null,
          rawPayload: {},
        },
        "GET /v1/approvals": () => delayedApprovals,
      }),
    );

    const { container } = render(<App />);

    const threadView = await screen.findByRole("main", { name: /thread/i });
    expect(await within(threadView).findByRole("heading", { name: /recent idle thread/i })).toBeInTheDocument();

    await act(async () => {
      resolveApprovals({ approvals: [approval] });
      await Promise.resolve();
    });

    await waitFor(() => {
      const threadButtons = Array.from(container.querySelectorAll<HTMLElement>(".kodex-thread-select-button"));
      expect(threadButtons[0]).toHaveTextContent(/older approval thread/i);
      expect(threadButtons[0].closest(".kodex-list-button")).not.toHaveAttribute("data-active", "true");
    });
    expect(await within(threadView).findByRole("heading", { name: /recent idle thread/i })).toBeInTheDocument();
  });

  it("posts schema-shaped command, file, permission, MCP, and tool-user-input approval responses", async () => {
    const approval = {
      id: "approval-1",
      requestId: "request-1",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: { command: "cargo test", cwd: "/home/example/kodex", reason: "Verify frontend" },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    const fileApproval = {
      ...approval,
      id: "approval-2",
      method: "item/fileChange/requestApproval",
      payload: { path: "src/App.tsx", reason: "Apply generated patch" },
    };
    const permissionApproval = {
      ...approval,
      id: "approval-3",
      method: "item/permissions/requestApproval",
      payload: {
        reason: "Needs network access",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    };
    const mcpApproval = {
      ...approval,
      id: "approval-4",
      method: "mcpServer/elicitation/request",
      payload: { message: "Share workspace metadata?" },
    };
    const userInputApproval = {
      ...approval,
      id: "approval-5",
      method: "item/tool/requestUserInput",
      payload: {
        questions: [{ id: "choice", header: "Choice", question: "Pick one" }],
      },
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/approvals": {
          approvals: [approval, fileApproval, permissionApproval, mcpApproval, userInputApproval],
        },
        "POST /v1/approvals/approval-1/decision": { ...approval, status: "resolved", response: { decision: "accept" } },
        "POST /v1/approvals/approval-2/decision": {
          ...fileApproval,
          status: "resolved",
          response: { decision: "acceptForSession" },
        },
        "POST /v1/approvals/approval-3/decision": {
          ...permissionApproval,
          status: "resolved",
          response: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" },
        },
        "POST /v1/approvals/approval-4/decision": {
          ...mcpApproval,
          status: "resolved",
          response: { action: "decline" },
        },
        "POST /v1/approvals/approval-5/decision": {
          ...userInputApproval,
          status: "resolved",
          response: { answers: { choice: { answers: [] } } },
        },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(within(timeline).getByText(/would you like to run the following command/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/\$ cargo test/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/src\/app\.tsx/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/needs network access/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/share workspace metadata/i)).toBeInTheDocument();
    const permissionCard = within(timeline)
      .getByText(/needs network access/i)
      .closest(".kodex-approval-card") as HTMLElement;
    expect(within(permissionCard).getByRole("button", { name: /no, continue without permissions/i })).toBeInTheDocument();
    await userEvent.click(within(timeline).getAllByRole("button", { name: /yes, proceed/i })[0]);
    await userEvent.click(within(timeline).getByRole("button", { name: /yes, and don't ask again for these files/i }));
    await userEvent.click(within(timeline).getByRole("button", { name: /yes, grant these permissions for this turn/i }));
    await userEvent.click(within(timeline).getByRole("button", { name: /no, but continue without it/i }));
    await userEvent.click(within(timeline).getByRole("button", { name: /submit answers/i }));

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/approvals/approval-1/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-2/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-3/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-4/decision")).toHaveLength(1);
      expect(gateway.callsFor("POST", "/v1/approvals/approval-5/decision")).toHaveLength(1);
      expect(within(timeline).queryByText(/cargo test/i)).not.toBeInTheDocument();
    });

    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-1/decision")[0])).resolves.toEqual({
      decision: { decision: "accept" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-2/decision")[0])).resolves.toEqual({
      decision: { decision: "acceptForSession" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-3/decision")[0])).resolves.toEqual({
      decision: { permissions: { network: { enabled: true }, fileSystem: null }, scope: "turn" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-4/decision")[0])).resolves.toEqual({
      decision: { action: "decline" },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-5/decision")[0])).resolves.toEqual({
      decision: { answers: { choice: { answers: [] } } },
    });
  });

  it("posts strict auto review for turn-scoped permission approval", async () => {
    const approval = {
      id: "approval-strict-permissions",
      requestId: "request-strict-permissions",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/permissions/requestApproval",
      status: "pending",
      payload: {
        reason: "Needs network access",
        permissions: { network: { enabled: true }, fileSystem: null },
      },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [approval] },
        "POST /v1/approvals/approval-strict-permissions/decision": {
          ...approval,
          status: "resolved",
          response: {
            permissions: { network: { enabled: true }, fileSystem: null },
            scope: "turn",
            strictAutoReview: true,
          },
        },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    await userEvent.click(
      within(timeline).getByRole("button", { name: /yes, grant for this turn with strict auto review/i }),
    );

    await waitFor(() => {
      expect(gateway.callsFor("POST", "/v1/approvals/approval-strict-permissions/decision")).toHaveLength(1);
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-strict-permissions/decision")[0])).resolves.toEqual({
      decision: {
        permissions: { network: { enabled: true }, fileSystem: null },
        scope: "turn",
        strictAutoReview: true,
      },
    });
  });

  it("renders command approvals with a human title and command block", async () => {
    const approval = {
      id: "approval-command-display",
      requestId: "request-command-display",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: {
        command: "npm run build -- --mode production && npm run test:e2e",
        cwd: "/home/example/kodex/apps/web",
        reason: "Verify production UI",
      },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [approval] },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/would you like to run the following command/i)).toBeInTheDocument();
    expect(within(timeline).getByText(/reason: verify production ui/i)).toBeInTheDocument();
    const command = within(timeline).getByText(/\$ npm run build -- --mode production/i);
    expect(command.closest("code")).toHaveClass("kodex-approval-command");
  });

  it("keeps long approval commands and action labels inside the card", async () => {
    const longPrefix = `allow ${"very-long-option-without-natural-breaks-".repeat(8)}suffix`;
    const longCommand = `/usr/bin/env ${"--long-option-without-natural-breaks=".repeat(8)}value`;
    const approval = {
      id: "approval-long-display",
      requestId: "request-long-display",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: {
        command: longCommand,
        commandActions: [{ type: "unknown", command: longCommand }],
        cwd: "/home/example/kodex",
        proposedExecpolicyAmendment: [longPrefix],
        reason: "Exercise long approval text",
      },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [approval] },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    const command = await within(timeline).findByText(`$ ${longCommand}`);
    const action = within(timeline).getByRole("button", {
      name: /yes, and don't ask again for commands that start with/i,
    });

    expect(command).toHaveClass("kodex-approval-command");
    expect(action).toHaveClass("kodex-approval-action");
    expect(appCss).toMatch(/\.kodex-approval-command\s*\{[^}]*min-width:\s*0;/s);
    expect(appCss).toMatch(/\.kodex-approval-command\s*\{[^}]*max-width:\s*100%;/s);
    expect(appCss).toMatch(/\.kodex-approval-command\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(appCss).toMatch(/\.kodex-approval-action\s*\{[^}]*max-width:\s*100%;/s);
    expect(appCss).toMatch(/\.kodex-approval-action\s*\{[^}]*white-space:\s*normal;/s);
    expect(appCss).toMatch(/\.kodex-thread-list-button:hover\s+\.kodex-thread-archive-button/s);
    expect(appCss).toMatch(/\.kodex-thread-list-button:hover\s+\.kodex-thread-unread-agent-turn-indicator/s);
  });

  it("renders command approval actions and posts amendment approval responses", async () => {
    const execPolicyApproval = {
      id: "approval-policy",
      requestId: "request-policy",
      threadId: thread.id,
      turnId: "turn-1",
      itemId: "item-1",
      method: "item/commandExecution/requestApproval",
      status: "pending",
      payload: {
        command: "rg TODO apps/web",
        commandActions: [{ type: "search", command: "rg", path: "apps/web", query: "TODO" }],
        cwd: "/home/example/kodex",
        proposedExecpolicyAmendment: ["allow rg TODO apps/web"],
        reason: "Search source",
      },
      response: null,
      createdAt: "2026-04-30T00:00:00Z",
      resolvedAt: null,
    };
    const networkPolicyApproval = {
      ...execPolicyApproval,
      id: "approval-network",
      requestId: "request-network",
      payload: {
        command: "curl https://api.example.com",
        commandActions: [{ type: "unknown", command: "curl https://api.example.com" }],
        cwd: "/home/example/kodex",
        networkApprovalContext: { host: "api.example.com" },
        proposedNetworkPolicyAmendments: [{ action: "allow", host: "api.example.com" }],
        reason: "Fetch API data",
      },
    };
    const gateway = mockGateway(
      baseRoutes({
        "GET /v1/approvals": { approvals: [execPolicyApproval, networkPolicyApproval] },
        "POST /v1/approvals/approval-policy/decision": {
          ...execPolicyApproval,
          status: "resolved",
          response: {
            decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["allow rg TODO apps/web"] } },
          },
        },
        "POST /v1/approvals/approval-network/decision": {
          ...networkPolicyApproval,
          status: "resolved",
          response: {
            decision: {
              applyNetworkPolicyAmendment: { network_policy_amendment: { action: "allow", host: "api.example.com" } },
            },
          },
        },
      }),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /implement frontend/i });
    const timeline = await screen.findByRole("main", { name: /thread/i });
    expect(await within(timeline).findByText(/search todo in apps\/web/i)).toBeInTheDocument();
    expect(within(timeline).getAllByText(/curl https:\/\/api\.example\.com/i).length).toBeGreaterThan(0);

    await userEvent.click(
      within(timeline).getByRole("button", {
        name: /yes, and don't ask again for commands that start with `allow rg todo apps\/web`/i,
      }),
    );
    await userEvent.click(within(timeline).getByRole("button", { name: /yes, and allow this host in the future/i }));

    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-policy/decision")[0])).resolves.toEqual({
      decision: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["allow rg TODO apps/web"] } } },
    });
    await expect(requestJson(gateway.callsFor("POST", "/v1/approvals/approval-network/decision")[0])).resolves.toEqual({
      decision: {
        decision: {
          applyNetworkPolicyAmendment: { network_policy_amendment: { action: "allow", host: "api.example.com" } },
        },
      },
    });
  });

});
