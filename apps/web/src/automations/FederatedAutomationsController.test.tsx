import { MantineProvider } from "@mantine/core";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { Automation, AutomationCreateRequest, AutomationUpdateRequest, GatewayClient } from "../api/client";
import {
  ExecutorRuntimeProvider,
  ExecutorRuntimeRegistryProvider,
} from "../api/GatewayClientContext";
import { createKodexQueryClient, type ExecutorRuntime } from "../api/queryClient";
import { queryKeys } from "../api/queryKeys";
import { FederatedCatalogProvider, type FederatedCatalogContextValue } from "../federation/FederatedCatalogContext";
import { FederatedAutomationsController, routeFederatedAutomationEvent } from "./FederatedAutomationsController";
import { AutomationsPane } from "./AutomationsPane";

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeEach(() => Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }));
afterEach(() => {
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

const sharedAutomation: Automation = {
  id: "shared-id",
  name: "Shared automation",
  prompt: "Check the repository.",
  targetThreadId: "thread",
  schedule: { startAt: "2026-10-13T01:00:00Z", repeatEvery: { value: 1, unit: "hours" } },
  nextRunAt: "2026-10-13T02:00:00Z",
  status: "active",
  pausedReason: null,
  lastRunAt: null,
  lastNativeQueueId: null,
  lastError: null,
  consecutiveFailureCount: 0,
  provenance: null,
  createdAt: "2026-10-12T01:00:00Z",
  updatedAt: "2026-10-12T01:00:00Z",
};

function runtime(executorId: string, api: GatewayClient, instanceId = `instance-${executorId}`): ExecutorRuntime {
  return {
    api,
    connection: Object.freeze({ executorId, instanceId }),
    queryClient: createKodexQueryClient(),
    storage: null,
  };
}

it("aggregates colliding automation ids and routes mutations through their owning executor", async () => {
  const updateFirst = vi.fn(async (_id: string, request: AutomationUpdateRequest) => ({ ...sharedAutomation, ...request, name: "First updated" }));
  const updateSecond = vi.fn(async (_id: string, request: AutomationUpdateRequest) => ({ ...sharedAutomation, ...request, name: "Second updated" }));
  const createFirst = vi.fn();
  const createSecond = vi.fn(async (request: AutomationCreateRequest) => ({ ...sharedAutomation, ...request, id: "second-created" }));
  const firstApi = {
    createAutomation: createFirst,
    deleteAutomation: vi.fn(),
    listAutomations: vi.fn(async () => [{ ...sharedAutomation, name: "First schedule" }]),
    pauseAutomation: vi.fn(),
    resumeAutomation: vi.fn(),
    updateAutomation: updateFirst,
  } as unknown as GatewayClient;
  const secondApi = {
    createAutomation: createSecond,
    deleteAutomation: vi.fn(),
    listAutomations: vi.fn(async () => [{ ...sharedAutomation, name: "Second schedule" }]),
    pauseAutomation: vi.fn(),
    resumeAutomation: vi.fn(),
    updateAutomation: updateSecond,
  } as unknown as GatewayClient;
  const first = runtime("first", firstApi);
  const second = runtime("second", secondApi);
  const federation = {
    catalog: null,
    error: null,
    executors: [{ id: "first", displayName: "Desk Mac" }, { id: "second", displayName: "Linux box" }],
    moveItem: vi.fn(), probeExecutor: vi.fn(), registerExecutor: vi.fn(), removeExecutor: vi.fn(),
    refresh: vi.fn(), refreshExecutors: vi.fn(), refreshing: false, updateExecutor: vi.fn(),
  } as unknown as FederatedCatalogContextValue;

  render(
    <QueryClientProvider client={first.queryClient}>
      <FederatedCatalogProvider value={federation}>
        <ExecutorRuntimeRegistryProvider runtimes={[first, second]}>
          <ExecutorRuntimeProvider runtime={first}>
            <FederatedAutomationsController active preferredExecutorId="first">
              {(value) => <>
                {value.rows.map((row) => <span data-testid="automation" key={row.key}>{row.executorName}:{row.automation.name}</span>)}
                <button onClick={() => void value.updateAutomation("second", "instance-second", "shared-id", { name: "Changed" })}>Update second</button>
                <button onClick={() => void value.createAutomation("second", "instance-second", {
                  name: "Created", prompt: "Prompt", targetThreadId: "thread",
                  schedule: { startAt: "2026-10-13T01:00:00Z", repeatEvery: { value: 1, unit: "hours" } },
                })}>Create second</button>
              </>}
            </FederatedAutomationsController>
          </ExecutorRuntimeProvider>
        </ExecutorRuntimeRegistryProvider>
      </FederatedCatalogProvider>
    </QueryClientProvider>,
  );

  await waitFor(() => expect(screen.getAllByTestId("automation")).toHaveLength(2));
  expect(screen.getByText("Desk Mac:First schedule")).toBeInTheDocument();
  expect(screen.getByText("Linux box:Second schedule")).toBeInTheDocument();
  expect(firstApi.listAutomations).toHaveBeenCalledTimes(1);
  expect(secondApi.listAutomations).toHaveBeenCalledTimes(1);
  expect(createFirst).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Update second" }));
  await waitFor(() => expect(updateSecond).toHaveBeenCalledWith("shared-id", { name: "Changed" }));
  expect(updateFirst).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Create second" }));
  await waitFor(() => expect(createSecond).toHaveBeenCalledTimes(1));
  expect(createFirst).not.toHaveBeenCalled();
});

it("applies live changes only to the emitting executor cache", async () => {
  const firstApi = { listAutomations: vi.fn(async () => [{ ...sharedAutomation, name: "First" }]) } as unknown as GatewayClient;
  const secondApi = { listAutomations: vi.fn(async () => [{ ...sharedAutomation, name: "Second" }]) } as unknown as GatewayClient;
  const first = runtime("first", firstApi);
  const second = runtime("second", secondApi);
  const federation = {
    catalog: null, error: null,
    executors: [{ id: "first", displayName: "Desk Mac" }, { id: "second", displayName: "Linux box" }],
    moveItem: vi.fn(), probeExecutor: vi.fn(), registerExecutor: vi.fn(), removeExecutor: vi.fn(),
    refresh: vi.fn(), refreshExecutors: vi.fn(), refreshing: false, updateExecutor: vi.fn(),
  } as unknown as FederatedCatalogContextValue;

  render(
    <FederatedCatalogProvider value={federation}>
      <ExecutorRuntimeRegistryProvider runtimes={[first, second]}>
        <ExecutorRuntimeProvider runtime={first}>
          <FederatedAutomationsController active preferredExecutorId="first">
            {(value) => <>{value.rows.map((row) => <span data-testid={row.executorId} key={row.key}>{row.automation.name}</span>)}</>}
          </FederatedAutomationsController>
        </ExecutorRuntimeProvider>
      </ExecutorRuntimeRegistryProvider>
    </FederatedCatalogProvider>,
  );
  await screen.findByText("Second");

  act(() => routeFederatedAutomationEvent(second.queryClient, {
    id: "second-live", seq: 2, kind: "automation.item_upsert", threadId: "thread",
    payload: { ...sharedAutomation, name: "Second live" }, receivedAt: "2026-10-12T02:00:00Z",
  }));

  expect(await screen.findByText("Second live")).toBeInTheDocument();
  expect(screen.getByTestId("first")).toHaveTextContent("First");
});

it("labels owners and keeps edit, run history, and creation on the selected executor", async () => {
  const updateFirst = vi.fn();
  const updateSecond = vi.fn(async (_id: string, request: AutomationUpdateRequest) => ({ ...sharedAutomation, ...request }));
  const createFirst = vi.fn();
  const createSecond = vi.fn(async (request: AutomationCreateRequest) => ({ ...sharedAutomation, ...request, id: "created" }));
  const listFirstRuns = vi.fn(async () => []);
  const listSecondRuns = vi.fn(async () => []);
  const first = runtime("first", {
    createAutomation: createFirst, deleteAutomation: vi.fn(), listAutomationRuns: listFirstRuns,
    listAutomations: vi.fn(async () => [{ ...sharedAutomation, name: "First schedule" }]),
    pauseAutomation: vi.fn(), resumeAutomation: vi.fn(), updateAutomation: updateFirst,
  } as unknown as GatewayClient);
  const second = runtime("second", {
    createAutomation: createSecond, deleteAutomation: vi.fn(), listAutomationRuns: listSecondRuns,
    listAutomations: vi.fn(async () => [{ ...sharedAutomation, name: "Second schedule" }]),
    pauseAutomation: vi.fn(), resumeAutomation: vi.fn(), updateAutomation: updateSecond,
  } as unknown as GatewayClient);
  const thread = (id: string, name: string) => ({
    id, name, preview: name, parentThreadId: null, projectId: null, cwd: "/tmp", status: "idle",
    source: "local", notificationsEnabled: true, canAcceptDirectInput: true,
    createdAt: 1, updatedAt: 1, recencyAt: 1, readAt: null, readRevision: 0,
    latestCompletionId: null, latestCompletionRevision: null, hasUnread: false,
  });
  const snapshot = (id: string, name: string) => ({
    projects: [], projectThreads: {}, pinnedThreads: { threads: [], nextCursor: null },
    chatThreads: { threads: [thread(id, name)], nextCursor: null },
  });
  const federation = {
    catalog: {
      executors: [
        { executorId: "first", executorName: "Desk Mac", generation: 1, observedAt: 1, stale: false, snapshot: snapshot("first-thread", "Mac chat") },
        { executorId: "second", executorName: "Linux box", generation: 1, observedAt: 1, stale: false, snapshot: snapshot("second-thread", "Linux chat") },
      ],
      orderRevision: 1, pinnedOrder: [], projectOrder: [], revision: 1,
    },
    error: null,
    executors: [{ id: "first", displayName: "Desk Mac" }, { id: "second", displayName: "Linux box" }],
    moveItem: vi.fn(), probeExecutor: vi.fn(), registerExecutor: vi.fn(), removeExecutor: vi.fn(),
    refresh: vi.fn(), refreshExecutors: vi.fn(), refreshing: false, updateExecutor: vi.fn(),
  } as unknown as FederatedCatalogContextValue;

  render(
    <MantineProvider env="test">
      <FederatedCatalogProvider value={federation}>
        <ExecutorRuntimeRegistryProvider runtimes={[first, second]}>
          <ExecutorRuntimeProvider runtime={first}>
            <AutomationsPane automations={[]} defaultThreadId={null} executorId="first" isLoading={false}
              onCreateAutomation={vi.fn()} onDeleteAutomation={vi.fn()} onPauseAutomation={vi.fn()} onResumeAutomation={vi.fn()}
              onShowMobileSidebar={vi.fn()} onUpdateAutomation={vi.fn()} preferredExecutorId="first" threadOptions={[]} />
          </ExecutorRuntimeProvider>
        </ExecutorRuntimeRegistryProvider>
      </FederatedCatalogProvider>
    </MantineProvider>,
  );

  const secondName = await screen.findByText("Second schedule");
  const secondRow = secondName.closest("tr");
  expect(secondRow).not.toBeNull();
  expect(within(secondRow!).getAllByText("Linux box")).not.toHaveLength(0);
  await userEvent.click(secondRow!);
  const editor = await screen.findByRole("dialog", { name: "Automation details" });
  await waitFor(() => expect(listSecondRuns).toHaveBeenCalledWith("shared-id", expect.anything()));
  expect(listFirstRuns).not.toHaveBeenCalled();
  const name = within(editor).getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Linux updated");
  await userEvent.click(within(editor).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(updateSecond).toHaveBeenCalledWith("shared-id", expect.objectContaining({ name: "Linux updated" })));
  expect(updateFirst).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Add automation" }));
  const picker = await screen.findByRole("dialog", { name: "New automation" });
  await userEvent.click(within(picker).getByRole("textbox", { name: "Executor" }));
  await userEvent.click(await screen.findByRole("option", { name: "Linux box" }));
  await userEvent.click(within(picker).getByRole("button", { name: "Continue" }));
  const createEditor = await screen.findByRole("dialog", { name: "New automation" });
  expect(within(createEditor).getByRole("textbox", { name: "Target thread" })).toHaveValue("Linux chat");
  await userEvent.type(within(createEditor).getByRole("textbox", { name: "Name" }), "Linux created");
  await userEvent.type(within(createEditor).getByLabelText("Automation prompt"), "Run there");
  await userEvent.click(within(createEditor).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(createSecond).toHaveBeenCalledWith(expect.objectContaining({ name: "Linux created", targetThreadId: "second-thread" })));
  expect(createFirst).not.toHaveBeenCalled();
});

it("preserves an automation draft and disables its actions while the owner is offline", async () => {
  const updateAutomation = vi.fn();
  const api = {
    listAutomationRuns: vi.fn(async () => []),
    listAutomations: vi.fn(async () => [{ ...sharedAutomation, name: "Scheduled work" }]),
    updateAutomation,
  } as unknown as GatewayClient;
  const selected = runtime("selected", api);
  const federation = {
    catalog: null, error: null, executors: [{ id: "selected", displayName: "Selected box" }],
    moveItem: vi.fn(), probeExecutor: vi.fn(), registerExecutor: vi.fn(), removeExecutor: vi.fn(),
    refresh: vi.fn(), refreshExecutors: vi.fn(), refreshing: false, updateExecutor: vi.fn(),
  } as unknown as FederatedCatalogContextValue;
  function Harness() {
    const [available, setAvailable] = useState(true);
    return <>
      <button onClick={() => setAvailable((value) => !value)}>Toggle executor</button>
      <ExecutorRuntimeRegistryProvider availableExecutorIds={available ? ["selected"] : []} runtimes={[selected]}>
        <ExecutorRuntimeProvider runtime={selected}>
          <AutomationsPane automations={[]} defaultThreadId={null} executorId="selected" isLoading={false}
            onCreateAutomation={vi.fn()} onDeleteAutomation={vi.fn()} onPauseAutomation={vi.fn()} onResumeAutomation={vi.fn()}
            onShowMobileSidebar={vi.fn()} onUpdateAutomation={vi.fn()} threadOptions={[]} />
        </ExecutorRuntimeProvider>
      </ExecutorRuntimeRegistryProvider>
    </>;
  }
  render(<MantineProvider env="test"><FederatedCatalogProvider value={federation}><Harness /></FederatedCatalogProvider></MantineProvider>);

  await userEvent.click((await screen.findByText("Scheduled work")).closest("tr")!);
  let editor = within(await screen.findByRole("dialog", { name: "Automation details" }));
  const name = editor.getByRole("textbox", { name: "Name" });
  await userEvent.clear(name);
  await userEvent.type(name, "Offline draft");

  fireEvent.click(screen.getByText("Toggle executor"));
  editor = within(screen.getByRole("dialog", { name: "Automation details" }));
  expect(editor.getByRole("textbox", { name: "Name" })).toHaveValue("Offline draft");
  expect(editor.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(editor.getByText("Reconnect this executor to change the automation.")).toBeInTheDocument();
  expect(updateAutomation).not.toHaveBeenCalled();

  fireEvent.click(screen.getByText("Toggle executor"));
  await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Automation details" })).getByRole("button", { name: "Save" })).toBeEnabled());
  expect(within(screen.getByRole("dialog", { name: "Automation details" })).getByRole("textbox", { name: "Name" })).toHaveValue("Offline draft");
});

it("replaces disconnected membership after the stream connection invalidates the initial list", async () => {
  const listAutomations = vi.fn()
    .mockResolvedValueOnce([{ ...sharedAutomation, name: "Removed before stream open" }])
    .mockResolvedValueOnce([]);
  const selected = runtime("selected", { listAutomations } as unknown as GatewayClient);
  const federation = {
    catalog: null, error: null, executors: [{ id: "selected", displayName: "Selected box" }],
    moveItem: vi.fn(), probeExecutor: vi.fn(), registerExecutor: vi.fn(), removeExecutor: vi.fn(),
    refresh: vi.fn(), refreshExecutors: vi.fn(), refreshing: false, updateExecutor: vi.fn(),
  } as unknown as FederatedCatalogContextValue;

  render(
    <FederatedCatalogProvider value={federation}>
      <ExecutorRuntimeRegistryProvider runtimes={[selected]}>
        <ExecutorRuntimeProvider runtime={selected}>
          <FederatedAutomationsController active preferredExecutorId="selected">
            {(value) => <span data-testid="row-count">{value.rows.length}</span>}
          </FederatedAutomationsController>
        </ExecutorRuntimeProvider>
      </ExecutorRuntimeRegistryProvider>
    </FederatedCatalogProvider>,
  );

  await waitFor(() => expect(screen.getByTestId("row-count")).toHaveTextContent("1"));
  await act(async () => {
    await selected.queryClient.invalidateQueries({ queryKey: queryKeys.automations });
  });
  await waitFor(() => expect(screen.getByTestId("row-count")).toHaveTextContent("0"));
  expect(listAutomations).toHaveBeenCalledTimes(2);
});

it("closes an editor and never routes stale ownership through a replacement instance", async () => {
  const oldUpdate = vi.fn();
  const replacementUpdate = vi.fn();
  const oldRuntime = runtime("selected", {
    listAutomationRuns: vi.fn(async () => []),
    listAutomations: vi.fn(async () => [{ ...sharedAutomation, name: "Old instance schedule" }]),
    updateAutomation: oldUpdate,
  } as unknown as GatewayClient, "instance-old");
  const replacementRuntime = runtime("selected", {
    listAutomationRuns: vi.fn(async () => []),
    listAutomations: vi.fn(async () => [{ ...sharedAutomation, name: "Replacement schedule" }]),
    updateAutomation: replacementUpdate,
  } as unknown as GatewayClient, "instance-new");
  const federation = {
    catalog: null, error: null, executors: [{ id: "selected", displayName: "Selected box" }],
    moveItem: vi.fn(), probeExecutor: vi.fn(), registerExecutor: vi.fn(), removeExecutor: vi.fn(),
    refresh: vi.fn(), refreshExecutors: vi.fn(), refreshing: false, updateExecutor: vi.fn(),
  } as unknown as FederatedCatalogContextValue;
  function Harness() {
    const [selected, setSelected] = useState(oldRuntime);
    return <>
      <button onClick={() => setSelected(replacementRuntime)}>Replace executor</button>
      <ExecutorRuntimeRegistryProvider runtimes={[selected]}>
        <ExecutorRuntimeProvider runtime={selected}>
          <AutomationsPane automations={[]} defaultThreadId={null} executorId="selected" isLoading={false}
            onCreateAutomation={vi.fn()} onDeleteAutomation={vi.fn()} onPauseAutomation={vi.fn()} onResumeAutomation={vi.fn()}
            onShowMobileSidebar={vi.fn()} onUpdateAutomation={vi.fn()} threadOptions={[]} />
        </ExecutorRuntimeProvider>
      </ExecutorRuntimeRegistryProvider>
    </>;
  }

  render(<MantineProvider env="test"><FederatedCatalogProvider value={federation}><Harness /></FederatedCatalogProvider></MantineProvider>);
  await userEvent.click((await screen.findByText("Old instance schedule")).closest("tr")!);
  expect(await screen.findByRole("dialog", { name: "Automation details" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Replace executor" }));

  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Automation details" })).not.toBeInTheDocument());
  expect(await screen.findByText("Replacement schedule")).toBeInTheDocument();
  expect(oldUpdate).not.toHaveBeenCalled();
  expect(replacementUpdate).not.toHaveBeenCalled();
});

it.each(["upsert", "delete"] as const)(
  "keeps a live %s when a cancelled list resolves before its replacement",
  async (operation) => {
    const snapshot = operation === "delete" ? [{ ...sharedAutomation, name: "Stale snapshot row" }] : [];
    const requests: Array<{
      resolve: (automations: Automation[]) => void;
      signal?: AbortSignal;
    }> = [];
    const listAutomations = vi.fn((_threadId?: string, signal?: AbortSignal) => new Promise<Automation[]>((resolve) => {
      requests.push({ resolve, signal });
    }));
    const selected = runtime("selected", { listAutomations } as unknown as GatewayClient);
    selected.queryClient.setQueryData(queryKeys.automations, snapshot);
    await selected.queryClient.invalidateQueries({ queryKey: queryKeys.automations });
    const federation = {
      catalog: null, error: null, executors: [{ id: "selected", displayName: "Selected box" }],
      moveItem: vi.fn(), probeExecutor: vi.fn(), registerExecutor: vi.fn(), removeExecutor: vi.fn(),
      refresh: vi.fn(), refreshExecutors: vi.fn(), refreshing: false, updateExecutor: vi.fn(),
    } as unknown as FederatedCatalogContextValue;

    render(
      <FederatedCatalogProvider value={federation}>
        <ExecutorRuntimeRegistryProvider runtimes={[selected]}>
          <ExecutorRuntimeProvider runtime={selected}>
            <FederatedAutomationsController active preferredExecutorId="selected">
              {(value) => <span data-testid="overlap-count">{value.rows.length}</span>}
            </FederatedAutomationsController>
          </ExecutorRuntimeProvider>
        </ExecutorRuntimeRegistryProvider>
      </FederatedCatalogProvider>,
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    void selected.queryClient.invalidateQueries({ queryKey: queryKeys.automations });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]!.signal?.aborted).toBe(true);

    act(() => routeFederatedAutomationEvent(selected.queryClient, {
      id: `live-${operation}`,
      kind: operation === "upsert" ? "automation.item_upsert" : "automation.item_deleted",
      payload: operation === "upsert" ? { ...sharedAutomation, name: "Live row" } : { id: sharedAutomation.id },
      receivedAt: "2026-10-12T03:00:00Z",
      seq: 3,
      threadId: null,
    }));
    act(() => requests[0]!.resolve(snapshot));
    await act(async () => Promise.resolve());
    act(() => requests[1]!.resolve(snapshot));

    await waitFor(() => expect(screen.getByTestId("overlap-count")).toHaveTextContent(operation === "upsert" ? "1" : "0"));
  },
);
