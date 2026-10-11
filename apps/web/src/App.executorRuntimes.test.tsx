import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { createGatewayClient } from "./api/client";
import type { FederatedCatalog, FederatedExecutor } from "./api/federatorClient";
import { createKodexQueryClient, type ExecutorRuntime } from "./api/queryClient";
import { queryKeys } from "./api/queryKeys";
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
    "GET /v1/directories": { path: `/${id}`, homePath: `/${id}`, parentPath: null, directories: [] },
    "POST /v1/projects": { id: "shared-project", name: `Project ${id}`, roots: [{ path: `/${id}` }], metadata: {}, position: 0, createdAt: 1, updatedAt: 1, recencyAt: null },
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

function registeredExecutor(id: string): FederatedExecutor {
  return {
    apiVersion: "4", appServerSchemaVersion: "0.160.0", baseUrl: `https://${id}.example`, createdAt: 1,
    displayName: id, enabled: true, generation: 1, id, instanceId: `instance-${id}`,
    lastError: null, lastSeenAt: 1, status: "ready", updatedAt: 1,
  };
}

function projectCatalog(staleExecutorB: boolean): FederatedCatalog {
  const project = {
    id: "shared-project", name: "Remote project", roots: [{ path: "/executor-b" }], metadata: {}, position: 0,
    createdAt: 1, updatedAt: 1, recencyAt: null,
  };
  return {
    revision: staleExecutorB ? 2 : 1,
    orderRevision: 1,
    projectOrder: [{ executorId: "executor-b", nativeId: project.id }],
    pinnedOrder: [],
    executors: ["executor-a", "executor-b"].map((executorId) => ({
      executorId,
      executorName: executorId === "executor-a" ? "Desk Mac" : "Build Linux",
      generation: 1,
      observedAt: 1_791_753_600,
      stale: executorId === "executor-b" && staleExecutorB,
      snapshot: {
        projects: executorId === "executor-b" ? [project] : [],
        projectThreads: executorId === "executor-b"
          ? { [project.id]: { threads: [], nextCursor: null } }
          : {},
        pinnedThreads: { threads: [], nextCursor: null },
        chatThreads: { threads: [], nextCursor: null },
      },
    })),
  };
}

describe("App executor runtime registry", () => {
  beforeEach(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1440);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(900);
    HTMLElement.prototype.scrollIntoView = vi.fn();
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

  it("opens colliding rows from the merged catalog through the owning executor", async () => {
    window.history.replaceState(null, "", "/executors/executor-a");
    const callsA: string[] = [];
    const callsB: string[] = [];
    const executorA = runtime("executor-a", callsA, false);
    const executorB = runtime("executor-b", callsB, false);
    const catalogThread = (id: string, executorId: string) => ({
      id, name: `Thread ${executorId}`, projectId: null, cwd: `/${executorId}`, status: "idle" as const,
      notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null,
      readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false, createdAt: 1, updatedAt: 2,
      parentThreadId: null, canAcceptDirectInput: true,
    });
    const catalog: FederatedCatalog = {
      revision: 3,
      orderRevision: 2,
      projectOrder: [],
      pinnedOrder: [],
      executors: ["executor-a", "executor-b"].map((executorId) => ({
        executorId,
        executorName: executorId === "executor-a" ? "Desk Mac" : "Build Linux",
        generation: 1,
        observedAt: 10,
        stale: false,
        snapshot: {
          projects: [], projectThreads: {}, pinnedThreads: { threads: [], nextCursor: null },
          chatThreads: { threads: [catalogThread("shared", executorId)], nextCursor: null },
        },
      })),
    };

    const paneStore = createMemoryWorkspacePaneStore();
    render(
      <App
        availableExecutorIds={["executor-a", "executor-b"]}
        executorRuntime={executorA}
        executorRuntimes={[executorA, executorB]}
        federatedCatalog={catalog}
        federatedExecutors={["executor-a", "executor-b"].map((id) => ({
          apiVersion: "4", appServerSchemaVersion: "0.160.0", baseUrl: `https://${id}.example`, createdAt: 1,
          displayName: id, enabled: true, generation: 1, id, instanceId: `instance-${id}`,
          lastError: null, lastSeenAt: 1, status: "ready" as const, updatedAt: 1,
        }))}
        moveFederatedCatalogItem={vi.fn().mockResolvedValue(undefined)}
        refreshFederatedCatalog={vi.fn().mockResolvedValue(undefined)}
        workspacePaneStore={paneStore}
      />,
    );

    const sidebar = within(await screen.findByRole("navigation", { name: "Workspace" }));
    await userEvent.click(sidebar.getByRole("button", { name: "Chats" }));
    expect(sidebar.getByText("Desk Mac")).toBeInTheDocument();
    expect(sidebar.getByText("Build Linux")).toBeInTheDocument();
    const executorBRow = sidebar.getByRole("button", { name: "Thread executor-b Build Linux" });
    await userEvent.click(executorBRow);

    expect(await screen.findByRole("heading", { name: "Thread executor-b" })).toBeInTheDocument();
    await waitFor(() => expect(callsB).toContain("POST /v1/threads/shared/attach"));
    expect(window.location.pathname).toBe("/executors/executor-b/threads/shared");
    expect(executorBRow.closest(".kodex-thread-list-button")).toHaveAttribute("data-active", "true");

    const executorARow = sidebar.getByRole("button", { name: "Thread executor-a Desk Mac" });
    await userEvent.click(executorARow);
    expect(executorARow.closest(".kodex-thread-list-button")).toHaveAttribute("data-active", "true");
    await userEvent.click(executorBRow);

    await userEvent.click(sidebar.getByRole("button", { name: "New chat" }));
    await userEvent.click(screen.getByRole("textbox", { name: "Executor" }));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => {
      const active = paneStore.getState().panes.find((pane) => pane.id === paneStore.getState().activePaneId);
      expect(active?.target).toEqual({ executorId: "executor-b", mode: "draft" });
    });

    const executorAProject = {
      id: "keep-a", name: "Keep A", roots: [{ path: "/executor-a" }], metadata: {}, position: 0,
      createdAt: 1, updatedAt: 1, recencyAt: null,
    };
    executorA.queryClient.setQueryData(queryKeys.projects, [executorAProject]);
    await userEvent.click(sidebar.getByRole("button", { name: "Projects" }));
    await userEvent.click(sidebar.getByRole("button", { name: "Add project" }));
    const projectPicker = within(await screen.findByRole("dialog", { name: "New project" }));
    await userEvent.click(projectPicker.getByRole("button", { name: "Continue" }));
    const projectDialog = within(await screen.findByRole("dialog", { name: "Add project" }));
    await userEvent.click(await projectDialog.findByRole("button", { name: "Use this directory" }));
    await userEvent.click(projectDialog.getByRole("button", { name: "Add project" }));
    await waitFor(() => {
      expect(callsB).toContain("POST /v1/projects");
      expect(callsA).not.toContain("POST /v1/projects");
      const active = paneStore.getState().panes.find((pane) => pane.id === paneStore.getState().activePaneId);
      expect(active?.target).toEqual({ executorId: "executor-b", mode: "draft", projectId: "shared-project" });
    });
    expect(executorA.queryClient.getQueryData(queryKeys.projects)).toEqual([executorAProject]);
  });

  it("does not expose the shell executor sidebar while the federated catalog is unavailable", async () => {
    window.history.replaceState(null, "", "/executors/executor-a");
    const callsA: string[] = [];
    const executorA = runtime("executor-a", callsA, false);
    const refreshCatalog = vi.fn().mockResolvedValue(undefined);

    render(
      <App
        availableExecutorIds={["executor-a"]}
        executorRuntime={executorA}
        executorRuntimes={[executorA]}
        federatedCatalog={null}
        federatedCatalogError="catalog unavailable"
        federatedExecutors={[]}
        moveFederatedCatalogItem={vi.fn().mockResolvedValue(undefined)}
        refreshFederatedCatalog={refreshCatalog}
      />,
    );

    const sidebar = within(await screen.findByRole("navigation", { name: "Workspace" }));
    expect(await sidebar.findByText("Could not load sidebar")).toBeInTheDocument();
    await userEvent.click(sidebar.getByRole("button", { name: "Chats" }));
    expect(sidebar.queryByText("Thread executor-a")).not.toBeInTheDocument();
    await userEvent.click(sidebar.getByRole("button", { name: "Retry" }));
    expect(refreshCatalog).toHaveBeenCalledTimes(1);
    await userEvent.click(sidebar.getByRole("button", { name: "New chat" }));
    const picker = within(await screen.findByRole("dialog", { name: "New chat" }));
    expect(picker.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("preserves an open remote project form but blocks creation while its catalog becomes stale", async () => {
    window.history.replaceState(null, "", "/executors/executor-a");
    const executorA = runtime("executor-a", [], false);
    const executorB = runtime("executor-b", [], false);
    const move = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const app = (catalog: FederatedCatalog) => (
      <App
        availableExecutorIds={["executor-a", "executor-b"]}
        executorRuntime={executorA}
        executorRuntimes={[executorA, executorB]}
        federatedCatalog={catalog}
        federatedExecutors={[registeredExecutor("executor-a"), registeredExecutor("executor-b")]}
        moveFederatedCatalogItem={move}
        refreshFederatedCatalog={refresh}
      />
    );
    const view = render(app(projectCatalog(false)));

    const sidebar = within(await screen.findByRole("navigation", { name: "Workspace" }));
    await userEvent.click(sidebar.getByRole("button", { name: "Add project" }));
    const picker = within(await screen.findByRole("dialog", { name: "New project" }));
    await userEvent.click(picker.getByRole("textbox", { name: "Executor" }));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await userEvent.click(picker.getByRole("button", { name: "Continue" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Add project" }));
    await userEvent.click(await dialog.findByRole("button", { name: "Use this directory" }));
    expect(dialog.getByText("/executor-b")).toBeInTheDocument();

    view.rerender(app(projectCatalog(true)));
    expect(await dialog.findByText(/navigation snapshot is stale/)).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Add project" })).toBeDisabled();
    expect(dialog.getByText("/executor-b")).toBeInTheDocument();

    view.rerender(app(projectCatalog(false)));
    await waitFor(() => expect(dialog.getByRole("button", { name: "Add project" })).toBeEnabled());
    expect(dialog.getByText("/executor-b")).toBeInTheDocument();
  });

  it("preserves remote project edits but blocks save and delete while its catalog becomes stale", async () => {
    window.history.replaceState(null, "", "/executors/executor-a");
    const executorA = runtime("executor-a", [], false);
    const executorB = runtime("executor-b", [], false);
    const move = vi.fn().mockResolvedValue(undefined);
    const refresh = vi.fn().mockResolvedValue(undefined);
    const app = (catalog: FederatedCatalog) => (
      <App
        availableExecutorIds={["executor-a", "executor-b"]}
        executorRuntime={executorA}
        executorRuntimes={[executorA, executorB]}
        federatedCatalog={catalog}
        federatedExecutors={[registeredExecutor("executor-a"), registeredExecutor("executor-b")]}
        moveFederatedCatalogItem={move}
        refreshFederatedCatalog={refresh}
      />
    );
    const view = render(app(projectCatalog(false)));

    const sidebar = within(await screen.findByRole("navigation", { name: "Workspace" }));
    await userEvent.click(await sidebar.findByRole("button", { name: "Project settings for Remote project" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Remote project · Project settings" }));
    const name = dialog.getByRole("textbox", { name: "Project name" });
    await userEvent.clear(name);
    await userEvent.type(name, "Edited remote project");
    expect(dialog.getByRole("button", { name: "Save project" })).toBeEnabled();

    view.rerender(app(projectCatalog(true)));
    expect(await dialog.findByText("Project editing paused")).toBeInTheDocument();
    expect(name).toHaveValue("Edited remote project");
    expect(dialog.getByRole("button", { name: "Save project" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "Delete project" })).toBeDisabled();

    view.rerender(app(projectCatalog(false)));
    await waitFor(() => expect(dialog.getByRole("button", { name: "Save project" })).toBeEnabled());
    expect(name).toHaveValue("Edited remote project");
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
