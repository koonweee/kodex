import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { createGatewayClient } from "./api/client";
import { createKodexQueryClient, type ExecutorRuntime } from "./api/queryClient";
import { createMemoryWorkspacePaneStore } from "./workspace/paneStore";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener() {}
  close() {}
}

function runtime(id: string, calls: string[], withApproval = true, threadId = "shared"): ExecutorRuntime {
  const api = createGatewayClient({
    baseUrl: window.location.origin,
    compatibilityRequired: () => false,
    fetch: async (input) => responseFor(id, calls, input, withApproval, threadId),
    routeUrl: (route) => new URL(`/v1/executors/${id}${route.slice(3)}`, window.location.origin).toString(),
  });
  return {
    api,
    connection: Object.freeze({ executorId: id, instanceId: `instance-${id}` }),
    queryClient: createKodexQueryClient(),
    storage: null,
  };
}

async function responseFor(id: string, calls: string[], input: RequestInfo | URL, withApproval: boolean, threadId: string): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);
  calls.push(`${request.method} ${url.pathname}`);
  const modelId = `model-${id}`;
  const thread = {
    id: threadId, name: `Thread ${id}`, projectId: null, cwd: `/${id}`, status: "idle",
    notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null,
    readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false, createdAt: 1, updatedAt: 2,
    parentThreadId: null, canAcceptDirectInput: true,
  };
  const approval = {
    id: "shared-approval",
    requestId: "shared-request",
    threadId,
    turnId: "shared-turn",
    itemId: null,
    method: "item/commandExecution/requestApproval",
    source: "native",
    status: "pending",
    payload: { command: `echo ${id}`, reason: id },
    response: null,
    createdAt: "2026-10-12T00:00:00Z",
    resolvedAt: null,
  };
  const routes: Record<string, unknown> = {
    "GET /v1/capabilities": { gateway: { apiVersion: "4", instanceId: `instance-${id}`, version: "test", sse: true, approvals: true, terminals: { enabled: true }, gatewayAuth: false, trustedNetworkOnly: true }, appServer: { ready: true, experimentalApi: true, schemaVersion: "0.160.0", detectedVersion: "0.160.0", detectedVersionMatchesSchema: true } },
    "GET /v1/sidebar/threads": { projects: [], projectThreads: {}, pinnedThreads: { threads: [], nextCursor: null }, chatThreads: { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} } },
    "GET /v1/projects": { projects: [] },
    "GET /v1/threads": { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
    "GET /v1/chats/threads": { threads: [thread], nextCursor: null, backwardsCursor: null, rawPayload: {} },
    "GET /v1/pinned-threads": { threads: [], nextCursor: null },
    "GET /v1/approvals": { runtimeId: `runtime-${id}`, revision: 1, approvals: withApproval ? [approval] : [] },
    "POST /v1/approvals/shared-approval/decision": { ...approval, status: "responding" },
    "GET /v1/account": { requiresOpenaiAuth: true, account: null, rawPayload: {} },
    "GET /v1/account/rate-limits": { rateLimits: null, rateLimitsByLimitId: null, rawPayload: {} },
    "GET /v1/automations": { automations: [] },
    "GET /v1/threads/unread-badge": { count: 0, readRevision: 0 },
    "GET /v1/models": { models: [{ id: modelId, model: modelId, displayName: modelId, description: id, defaultReasoningEffort: "medium", hidden: false, inputModalities: ["text"], isDefault: true, rawPayload: {}, supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }], upgrade: null }], nextCursor: null, rawPayload: {} },
    "GET /v1/permission-profiles": { profiles: [] },
    "GET /v1/composer-settings": { model: modelId, effort: "medium", serviceTier: null, permissionProfileId: null, permissionsPreset: null },
    [`GET /v1/threads/${threadId}/settings`]: { model: modelId, effort: "medium", serviceTier: null, activePermissionProfile: null },
    [`GET /v1/threads/${threadId}/app-surface`]: { session: null },
    [`GET /v1/threads/${threadId}/subagents`]: { subagents: [{ id: "shared-subagent", parentThreadId: threadId, agentNickname: `Scout ${id}`, agentRole: "worker", status: "idle", updatedAt: 2, preview: `Subagent ${id}`, canAcceptDirectInput: false }], nextCursor: null },
    [`GET /v1/threads/${threadId}/queued-inputs`]: { queuedInputs: [], transfers: [], nextCursor: null },
    [`GET /v1/threads/${threadId}/goal`]: { goal: null },
    [`POST /v1/threads/${threadId}/attach`]: { thread, liveState: "idle", timeline: { activeTurnId: null, liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 1 } },
  };
  const body = routes[`${request.method} ${url.pathname}`];
  return body === undefined
    ? Response.json({ code: "not_found", message: `${request.method} ${url.pathname}`, retryable: false }, { status: 404 })
    : Response.json(body);
}

describe("App executor runtime registry", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1440);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
    window.history.replaceState(null, "", "/executors/executor-a/threads/shared");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeEventSource.instances = [];
  });

  it("renders colliding adjacent thread IDs through their owning production runtime", async () => {
    const callsA: string[] = [];
    const callsB: string[] = [];
    const executorA = runtime("executor-a", callsA);
    const executorB = runtime("executor-b", callsB);
    const paneStore = createMemoryWorkspacePaneStore({
      schemaVersion: 2,
      activePaneId: "pane-a",
      dockviewLayout: null,
      panes: [
        { id: "pane-a", kind: "thread", target: { executorId: "executor-a", mode: "existing", threadId: "shared" }, title: null },
        { id: "pane-b", kind: "thread", target: { executorId: "executor-b", mode: "existing", threadId: "shared" }, title: null },
      ],
    });

    render(<App executorRuntime={executorA} executorRuntimes={[executorA, executorB]} workspacePaneStore={paneStore} />);

    expect(await screen.findByRole("heading", { name: "Thread executor-a" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Thread executor-b" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Model: model-executor-a, medium" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Model: model-executor-b, medium" })).toBeInTheDocument();
    expect(await screen.findByText("$ echo executor-a")).toBeInTheDocument();
    const executorBApproval = await screen.findByText("$ echo executor-b");
    const executorBCard = executorBApproval.closest(".kodex-approval-card")!;
    await userEvent.click(executorBCard.querySelector<HTMLButtonElement>('button[aria-label="Yes, proceed"]')!);
    await waitFor(() => {
      expect(callsA).toContain("POST /v1/threads/shared/attach");
      expect(callsB).toContain("POST /v1/threads/shared/attach");
      expect(callsA).toContain("GET /v1/threads/shared/settings");
      expect(callsB).toContain("GET /v1/threads/shared/settings");
      expect(callsA).toContain("GET /v1/approvals");
      expect(callsB).toContain("GET /v1/approvals");
      expect(callsA).toContain("GET /v1/threads/shared/subagents");
      expect(callsB).toContain("GET /v1/threads/shared/subagents");
      expect(callsB).toContain("POST /v1/approvals/shared-approval/decision");
      expect(callsA).not.toContain("POST /v1/approvals/shared-approval/decision");
    });
  });

  it("preserves each pane's unsent text and attachments while an executor is disabled and restored", async () => {
    const callsA: string[] = [];
    const callsB: string[] = [];
    const executorA = runtime("executor-a", callsA, false);
    const executorB = runtime("executor-b", callsB, false);
    const paneStore = createMemoryWorkspacePaneStore({
      schemaVersion: 2,
      activePaneId: "pane-a",
      dockviewLayout: null,
      panes: [
        { id: "pane-a", kind: "thread", target: { executorId: "executor-a", mode: "existing", threadId: "shared" }, title: null },
        { id: "pane-b", kind: "thread", target: { executorId: "executor-b", mode: "existing", threadId: "shared" }, title: null },
      ],
    });
    const view = render(
      <App
        availableExecutorIds={["executor-a", "executor-b"]}
        executorRuntime={executorA}
        executorRuntimes={[executorA, executorB]}
        workspacePaneStore={paneStore}
      />,
    );
    const headingA = await screen.findByRole("heading", { name: "Thread executor-a" });
    const headingB = await screen.findByRole("heading", { name: "Thread executor-b" });
    const paneA = headingA.closest<HTMLElement>(".kodex-workspace-pane-host")!;
    const paneB = headingB.closest<HTMLElement>(".kodex-workspace-pane-host")!;
    const composerA = within(paneA).getByRole("textbox", { name: "Message composer" });
    const composerB = within(paneB).getByRole("textbox", { name: "Message composer" });
    const attachmentA = within(paneA).getByLabelText<HTMLInputElement>("Add attachment");
    await waitFor(() => {
      expect(attachmentA).toBeEnabled();
    });

    await userEvent.type(composerA, "draft A");
    await userEvent.upload(attachmentA, new File(["A"], "a.png", { type: "image/png" }));
    expect(await within(paneA).findByRole("button", { name: "Remove a.png" })).toBeInTheDocument();
    await userEvent.type(composerB, "draft B");

    const callsBeforeDisable = callsA.length;
    view.rerender(
      <App
        availableExecutorIds={["executor-b"]}
        executorRuntime={executorA}
        executorRuntimes={[executorA, executorB]}
        federatedShellAvailable={false}
        workspacePaneStore={paneStore}
      />,
    );
    expect(await screen.findByText("Executor unavailable")).toBeInTheDocument();
    expect(composerA.isConnected).toBe(true);
    expect(composerA.closest<HTMLElement>("[aria-hidden='true']")).toHaveAttribute("inert");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsA).toHaveLength(callsBeforeDisable);

    view.rerender(
      <App
        availableExecutorIds={["executor-a", "executor-b"]}
        executorRuntime={executorA}
        executorRuntimes={[executorA, executorB]}
        workspacePaneStore={paneStore}
      />,
    );
    const nextPaneA = (await screen.findByRole("heading", { name: "Thread executor-a" })).closest<HTMLElement>(".kodex-workspace-pane-host")!;
    const nextPaneB = screen.getByRole("heading", { name: "Thread executor-b" }).closest<HTMLElement>(".kodex-workspace-pane-host")!;
    expect(composerA.isConnected).toBe(true);
    expect(composerB.isConnected).toBe(true);
    expect(within(nextPaneA).getByRole("textbox", { name: "Message composer" })).toHaveValue("draft A");
    expect(within(nextPaneB).getByRole("textbox", { name: "Message composer" })).toHaveValue("draft B");
    expect(within(nextPaneA).getByRole("button", { name: "Remove a.png" })).toBeInTheDocument();

  });

  it("opens a qualified popstate route through its executor and fails closed for an unavailable executor", async () => {
    const callsA: string[] = [];
    const callsB: string[] = [];
    const executorA = runtime("executor-a", callsA, false, "thread-a");
    const executorB = runtime("executor-b", callsB, false, "thread-b");
    const paneStore = createMemoryWorkspacePaneStore({
      schemaVersion: 2,
      activePaneId: "pane-a",
      dockviewLayout: null,
      panes: [
        { id: "pane-a", kind: "thread", target: { executorId: "executor-a", mode: "existing", threadId: "thread-a" }, title: null },
      ],
    });
    const view = render(
      <App
        availableExecutorIds={["executor-a", "executor-b"]}
        executorRuntime={executorA}
        executorRuntimes={[executorA, executorB]}
        workspacePaneStore={paneStore}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Thread executor-a" })).toBeInTheDocument();

    await act(async () => {
      window.history.pushState(null, "", "/executors/executor-b/threads/thread-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    const headingB = await screen.findByRole("heading", { name: "Thread executor-b" });
    await waitFor(() => expect(callsB).toContain("POST /v1/threads/thread-b/attach"));
    expect(callsA.some((call) => call.includes("/threads/thread-b/"))).toBe(false);
    const paneB = headingB.closest<HTMLElement>(".kodex-workspace-pane-host")!;
    const composerB = within(paneB).getByRole("textbox", { name: "Message composer" });
    await userEvent.click(composerB);
    expect(composerB).toHaveFocus();

    await act(async () => {
      window.history.pushState(null, "", "/executors/executor-c/threads/thread-c");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    view.rerender(
      <App
        availableExecutorIds={["executor-a", "executor-b"]}
        executorRuntime={executorA}
        executorRuntimes={[executorA, executorB]}
        federatedRouteError="Executor executor-c is unavailable."
        workspacePaneStore={paneStore}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Executor executor-c is unavailable.");
    expect(await screen.findByText("Executor unavailable")).toBeInTheDocument();
    expect(composerB).not.toHaveFocus();
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(callsA.some((call) => call.includes("thread-c"))).toBe(false);
    expect(callsB.some((call) => call.includes("thread-c"))).toBe(false);
    expect(callsB).not.toContain("POST /v1/threads/thread-b/input");
  });

  it("shows an unavailable initial thread route inside a healthy workspace", async () => {
    window.history.replaceState(null, "", "/executors/executor-b/threads/thread-b");
    const callsA: string[] = [];
    const executorA = runtime("executor-a", callsA, false, "thread-a");
    const paneStore = createMemoryWorkspacePaneStore({
      schemaVersion: 2,
      activePaneId: "pane-a",
      dockviewLayout: null,
      panes: [
        { id: "pane-a", kind: "thread", target: { executorId: "executor-a", mode: "existing", threadId: "thread-a" }, title: null },
      ],
    });

    render(
      <App
        availableExecutorIds={["executor-a"]}
        executorRuntime={executorA}
        executorRuntimes={[executorA]}
        federatedRouteError="Executor executor-b is unavailable."
        workspacePaneStore={paneStore}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Thread executor-a" })).toBeInTheDocument();
    expect(await screen.findByText("Executor unavailable")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Executor executor-b is unavailable.");
    expect(callsA.some((call) => call.includes("thread-b"))).toBe(false);
  });
});
