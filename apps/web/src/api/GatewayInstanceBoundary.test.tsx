import { MantineProvider } from "@mantine/core";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PwaLifecycle } from "../pwa/PwaLifecycle";
import { createEventStreamClient } from "../events/stream";
import { attachThread, getCapabilities, getProject, getThreadDetail, type Capabilities, type EventEnvelope, type Project, type ThreadViewResponse } from "./client";
import { GatewayInstanceBoundary, useGatewayInstanceStorage, useGatewayInstanceValidation, useGatewayStreamConnected } from "./GatewayInstanceBoundary";
import { createInstanceStorage } from "./instanceStorage";
import { createKodexQueryClient } from "./queryClient";
import { queryKeys } from "./queryKeys";

const pwa = vi.hoisted(() => ({
  needRefresh: false,
  register: vi.fn().mockResolvedValue({ registered: false, reason: "unsupported" }),
  update: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./client", () => ({ attachThread: vi.fn(), getCapabilities: vi.fn(), getProject: vi.fn(), getThreadDetail: vi.fn() }));
vi.mock("../pwa/registerServiceWorker", () => ({
  getPwaUpdateState: () => ({ needRefresh: pwa.needRefresh, updateServiceWorker: pwa.update }),
  registerPwaServiceWorker: pwa.register,
  subscribeToPwaUpdates: () => () => undefined,
}));

function capabilities(instanceId: string): Capabilities {
  return {
    gateway: { instanceId, version: "test", sse: true, approvals: true, terminals: { enabled: true }, gatewayAuth: false, trustedNetworkOnly: true },
    appServer: { ready: true, experimentalApi: true, schemaVersion: "0.160.0", detectedVersion: "0.160.0", detectedVersionMatchesSchema: true },
  };
}

function WorkspaceProbe() {
  const storage = useGatewayInstanceStorage();
  const [draft, setDraft] = useState(() => storage?.getItem("draft") ?? "fresh draft");
  return <button onClick={() => { storage?.setItem("draft", "edited draft"); setDraft("edited draft"); }}>{draft}</button>;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(seq: number) { this.onmessage?.({ data: JSON.stringify({ seq }) } as MessageEvent<string>); }
}

const ignoreEvent = () => {};

function StreamProbe({ onEvent = ignoreEvent }: { onEvent?: (event: EventEnvelope) => void }) {
  const beforeConnect = useGatewayInstanceValidation();
  const onConnected = useGatewayStreamConnected();
  const storage = useGatewayInstanceStorage();
  useEffect(() => {
    const threadId = storage?.getItem("selected-thread") ?? undefined;
    const client = createEventStreamClient({
      EventSourceCtor: FakeEventSource,
      beforeConnect,
      cursor: threadId ? 70 : undefined,
      onEvent,
      onStatusChange: (status) => { if (status === "connected") onConnected?.(); },
      reconnectDelayMs: 10,
      threadId,
    });
    client.connect();
    return client.close;
  }, [beforeConnect, onConnected, onEvent, storage]);
  return null;
}

function AccountProbe({ read }: { read: () => Promise<string> }) {
  const account = useQuery({ queryKey: queryKeys.account, queryFn: read });
  return <p>{account.data}</p>;
}

function SettingsProbe({ read, queryKey }: { read: (signal: AbortSignal) => Promise<string>; queryKey: readonly unknown[] }) {
  const settings = useQuery({ queryKey, queryFn: ({ signal }) => read(signal) });
  return <p>{settings.data}</p>;
}

function threadDetail(id: string): ThreadViewResponse {
  return {
    liveState: "idle",
    thread: { parentThreadId: null, canAcceptDirectInput: null, id, projectId: null, createdAt: 0, updatedAt: 0, cwd: "/workspace", status: "idle", notificationsEnabled: true, pinned: false, latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: false, unreadCompletedAgentTurn: false },
    timeline: { activeTurnId: null, liveState: "idle", pendingApprovalRequests: [], pendingUserInputRequests: [], rows: [], turns: [], viewRevision: 0 },
  };
}

function project(id: string): Project {
  return { id, name: "Native project", roots: [{ path: "/workspace" }], metadata: {}, position: 0, createdAt: 1791072000, updatedAt: 1791072000, recencyAt: null };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.mocked(getThreadDetail).mockReset();
  vi.mocked(getProject).mockReset();
  FakeEventSource.instances = [];
  pwa.needRefresh = false;
  window.localStorage.clear();
});

describe("gateway instance bootstrap", () => {
  it("opens the standalone theme workbench without checking or mounting instance state", () => {
    window.history.replaceState(null, "", "/__theme");
    const queryClient = createKodexQueryClient();
    queryClient.setQueryData(queryKeys.projects, [{ id: "untouched-project" }]);
    render(<GatewayInstanceBoundary queryClient={queryClient}><div>Theme workbench</div></GatewayInstanceBoundary>);

    expect(screen.getByText("Theme workbench")).toBeInTheDocument();
    expect(getCapabilities).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(queryKeys.projects)).toEqual([{ id: "untouched-project" }]);
  });

  it("keeps a waiting PWA update usable when the initial identity check fails", async () => {
    pwa.needRefresh = true;
    vi.mocked(getCapabilities).mockRejectedValueOnce(new Error("Gateway unavailable"));
    render(
      <GatewayInstanceBoundary queryClient={createKodexQueryClient()}>
        <MantineProvider><PwaLifecycle /><WorkspaceProbe /></MantineProvider>
      </GatewayInstanceBoundary>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to connect");
    expect(screen.getByRole("status")).toHaveTextContent("Update available");
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(pwa.update).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "fresh draft" })).not.toBeInTheDocument();

    vi.mocked(getCapabilities).mockResolvedValueOnce(capabilities("valid"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
  });

  it("waits for a fresh identity even when capabilities and thread data are cached", async () => {
    const queryClient = createKodexQueryClient();
    queryClient.setQueryData(queryKeys.capabilities, capabilities("old"));
    queryClient.setQueryData(queryKeys.projects, [{ id: "old-project" }]);
    let resolve!: (value: Capabilities) => void;
    vi.mocked(getCapabilities).mockReturnValueOnce(new Promise((done) => { resolve = done; }));

    render(<GatewayInstanceBoundary queryClient={queryClient}><WorkspaceProbe /></GatewayInstanceBoundary>);
    expect(screen.queryByRole("button", { name: "fresh draft" })).not.toBeInTheDocument();

    await act(async () => resolve(capabilities("new")));
    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.projects)).toBeUndefined();
    expect(queryClient.getQueryData(queryKeys.capabilities)).toEqual(capabilities("new"));
  });

  it("preserves same-instance drafts and remounts with fresh state when the gateway changes", async () => {
    const queryClient = createKodexQueryClient();
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    render(<GatewayInstanceBoundary queryClient={queryClient}><WorkspaceProbe /></GatewayInstanceBoundary>);
    fireEvent.click(await screen.findByRole("button", { name: "fresh draft" }));

    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(screen.getByRole("button", { name: "edited draft" })).toBeInTheDocument();

    vi.mocked(getCapabilities).mockResolvedValue(capabilities("second"));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();

    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(await screen.findByRole("button", { name: "edited draft" })).toBeInTheDocument();
  });

  it("does not mount instance consumers after an invalid or failed identity check and can retry", async () => {
    const queryClient = createKodexQueryClient();
    vi.mocked(getCapabilities).mockResolvedValueOnce(capabilities(""));
    render(<GatewayInstanceBoundary queryClient={queryClient}><WorkspaceProbe /></GatewayInstanceBoundary>);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "fresh draft" })).not.toBeInTheDocument();

    vi.mocked(getCapabilities).mockResolvedValueOnce(capabilities("valid"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    await waitFor(() => expect(getCapabilities).toHaveBeenCalledTimes(2));
  });

  it("keeps an already mounted draft through a failed recheck", async () => {
    vi.mocked(getCapabilities).mockResolvedValueOnce(capabilities("first"));
    render(<GatewayInstanceBoundary queryClient={createKodexQueryClient()}><WorkspaceProbe /></GatewayInstanceBoundary>);
    fireEvent.click(await screen.findByRole("button", { name: "fresh draft" }));

    vi.mocked(getCapabilities).mockRejectedValueOnce(new Error("Offline"));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(screen.getByRole("button", { name: "edited draft" })).toBeInTheDocument();
  });

  it("ignores an older identity response that arrives after a newer check", async () => {
    const queryClient = createKodexQueryClient();
    let resolveOld!: (value: Capabilities) => void;
    vi.mocked(getCapabilities).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    render(<GatewayInstanceBoundary queryClient={queryClient}><WorkspaceProbe /></GatewayInstanceBoundary>);

    vi.mocked(getCapabilities).mockResolvedValueOnce(capabilities("current"));
    await act(async () => { window.dispatchEvent(new Event("online")); });
    fireEvent.click(await screen.findByRole("button", { name: "fresh draft" }));
    await act(async () => resolveOld(capabilities("old")));

    expect(screen.getByRole("button", { name: "edited draft" })).toBeInTheDocument();
    expect(queryClient.getQueryData(queryKeys.capabilities)).toEqual(capabilities("current"));
  });

  it("validates a first-visit link with history only before mounting the workspace", async () => {
    window.history.replaceState(null, "", "/threads/native-thread");
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    let resolve!: (value: ThreadViewResponse) => void;
    vi.mocked(getThreadDetail).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    render(<GatewayInstanceBoundary queryClient={createKodexQueryClient()}><WorkspaceProbe /></GatewayInstanceBoundary>);

    await waitFor(() => expect(getThreadDetail).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "fresh draft" })).not.toBeInTheDocument();
    await act(async () => resolve(threadDetail("native-thread")));

    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/native-thread");
    expect(attachThread).not.toHaveBeenCalled();
  });

  it.each(["/threads/foreign", "/projects/foreign"])(
    "keeps a failed first-visit %s out of the workspace until the user retries or leaves the link",
    async (path) => {
      window.history.replaceState(null, "", path);
      vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
      vi.mocked(getThreadDetail).mockRejectedValue(new Error("Gateway request failed"));
      vi.mocked(getProject).mockRejectedValue(new Error("Gateway request failed"));
      render(<GatewayInstanceBoundary queryClient={createKodexQueryClient()}><WorkspaceProbe /></GatewayInstanceBoundary>);

      expect(await screen.findByRole("alert")).toHaveTextContent("This link could not be opened");
      expect(screen.queryByRole("button", { name: "fresh draft" })).not.toBeInTheDocument();
      expect(window.location.pathname).toBe(path);
      fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));

      expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
      expect(window.location.pathname).toBe("/");
    },
  );

  it("retries a valid notification link without discarding its destination", async () => {
    window.history.replaceState(null, "", "/threads/notification-thread");
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    vi.mocked(getThreadDetail)
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValueOnce(threadDetail("notification-thread"));
    render(<GatewayInstanceBoundary queryClient={createKodexQueryClient()}><WorkspaceProbe /></GatewayInstanceBoundary>);

    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/notification-thread");
  });

  it("ignores a pending route read after browser navigation replaces the initial link", async () => {
    window.history.replaceState(null, "", "/threads/old-link");
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    let resolve!: (value: ThreadViewResponse) => void;
    vi.mocked(getThreadDetail).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    vi.mocked(getProject).mockResolvedValue(project("native-project"));
    render(<GatewayInstanceBoundary queryClient={createKodexQueryClient()}><WorkspaceProbe /></GatewayInstanceBoundary>);
    await waitFor(() => expect(getThreadDetail).toHaveBeenCalled());

    await act(async () => {
      window.history.replaceState(null, "", "/projects/native-project");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    await act(async () => resolve(threadDetail("old-link")));

    expect(window.location.pathname).toBe("/projects/native-project");
    expect(screen.getByRole("button", { name: "fresh draft" })).toBeInTheDocument();
  });

  it.each(["/threads/foreign", "/projects/foreign"])("rejects a mismatched native ID returned for %s", async (path) => {
    window.history.replaceState(null, "", path);
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    vi.mocked(getThreadDetail).mockResolvedValue(threadDetail("another-thread"));
    vi.mocked(getProject).mockResolvedValue(project("another-project"));
    render(<GatewayInstanceBoundary queryClient={createKodexQueryClient()}><WorkspaceProbe /></GatewayInstanceBoundary>);

    expect(await screen.findByRole("alert")).toHaveTextContent("This link could not be opened");
    expect(screen.queryByRole("button", { name: "fresh draft" })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe(path);
  });

  it.each(["/threads/notification-thread", "/projects/project-1"])(
    "preserves %s for the same instance and clears it after a known replacement",
    async (path) => {
      window.history.replaceState(null, "", path);
      vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
      vi.mocked(getThreadDetail).mockResolvedValue(threadDetail("notification-thread"));
      vi.mocked(getProject).mockResolvedValue(project("project-1"));
      render(<GatewayInstanceBoundary queryClient={createKodexQueryClient()}><WorkspaceProbe /></GatewayInstanceBoundary>);
      await screen.findByRole("button", { name: "fresh draft" });
      expect(window.location.pathname).toBe(path);

      await act(async () => { window.dispatchEvent(new Event("online")); });
      expect(window.location.pathname).toBe(path);

      vi.mocked(getCapabilities).mockResolvedValue(capabilities("replacement"));
      await act(async () => { window.dispatchEvent(new Event("online")); });
      expect(window.location.pathname).toBe("/");
    },
  );

  it("keeps same-instance drafts and refetches missed account state only after the replacement stream opens", async () => {
    const queryClient = createKodexQueryClient();
    const readAccount = vi.fn().mockResolvedValue("Previous account state");
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    render(
      <GatewayInstanceBoundary queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <AccountProbe read={readAccount} /><WorkspaceProbe /><StreamProbe />
        </QueryClientProvider>
      </GatewayInstanceBoundary>,
    );
    await screen.findByText("Previous account state");
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0].onopen?.());
    await waitFor(() => expect(queryClient.isFetching({ queryKey: queryKeys.account })).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "fresh draft" }));
    let resolve!: (value: Capabilities) => void;
    vi.mocked(getCapabilities).mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    readAccount.mockResolvedValue("Updated account state");
    const readsBeforeReconnect = vi.mocked(getCapabilities).mock.calls.length;
    const accountReadsBeforeReconnect = readAccount.mock.calls.length;

    act(() => FakeEventSource.instances[0].onerror?.());
    await waitFor(() => expect(getCapabilities).toHaveBeenCalledTimes(readsBeforeReconnect + 1));
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(screen.getByText("Previous account state")).toBeInTheDocument();
    await act(async () => resolve(capabilities("first")));

    expect(FakeEventSource.instances).toHaveLength(2);
    act(() => FakeEventSource.instances[0].onopen?.());
    expect(readAccount).toHaveBeenCalledTimes(accountReadsBeforeReconnect);
    expect(screen.getByText("Previous account state")).toBeInTheDocument();
    act(() => FakeEventSource.instances[1].onopen?.());

    expect(await screen.findByText("Updated account state")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "edited draft" })).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("replaces an account read started before subscription when the first stream opens", async () => {
    const queryClient = createKodexQueryClient();
    let finishOld!: (value: string) => void;
    const readAccount = vi.fn<() => Promise<string>>()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValue("Updated account state");
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    render(
      <GatewayInstanceBoundary queryClient={queryClient}>
        <QueryClientProvider client={queryClient}><AccountProbe read={readAccount} /><StreamProbe /></QueryClientProvider>
      </GatewayInstanceBoundary>,
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(readAccount).toHaveBeenCalledTimes(1);
    await act(async () => {
      FakeEventSource.instances[0].onopen?.();
      finishOld("Previous account state");
    });

    expect(await screen.findByText("Updated account state")).toBeInTheDocument();
    expect(screen.queryByText("Previous account state")).not.toBeInTheDocument();
    expect(readAccount).toHaveBeenCalledTimes(2);
  });

  it.each([
    { kind: "thread", queryKey: queryKeys.threadSettings("native-chat"), trigger: "stream open" },
    { kind: "thread", queryKey: queryKeys.threadSettings("native-chat"), trigger: "foreground" },
    { kind: "native config", queryKey: queryKeys.composerSettings(null), trigger: "stream open" },
    { kind: "native config", queryKey: queryKeys.mcpConfiguredServers, trigger: "foreground" },
    { kind: "native subagents", queryKey: queryKeys.threadSubagents("ancestor"), trigger: "stream open" },
    { kind: "native subagents", queryKey: queryKeys.threadSubagents("ancestor"), trigger: "foreground" },
    { kind: "app surface", queryKey: queryKeys.appSurface("native-chat"), trigger: "stream open" },
    { kind: "app surface", queryKey: queryKeys.appSurface("native-chat"), trigger: "foreground" },
    { kind: "notification status", queryKey: queryKeys.notificationStatus, trigger: "stream open" },
    { kind: "notification status", queryKey: queryKeys.notificationStatus, trigger: "foreground" },
    { kind: "current device", queryKey: ["notifications", "current-device"], trigger: "stream open" },
    { kind: "current device", queryKey: ["notifications", "current-device"], trigger: "foreground" },
  ])("cancels a pre-recovery $kind read on $trigger while preserving the same-instance draft", async ({ queryKey, trigger }) => {
    const queryClient = createKodexQueryClient();
    let finishOld!: (value: string) => void;
    let oldSignal: AbortSignal | undefined;
    const readSettings = vi.fn<(signal: AbortSignal) => Promise<string>>()
      .mockImplementationOnce((signal) => {
        oldSignal = signal;
        return new Promise((resolve) => { finishOld = resolve; });
      }).mockResolvedValue("Current native settings");
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    render(
      <GatewayInstanceBoundary queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <SettingsProbe read={readSettings} queryKey={queryKey} /><WorkspaceProbe /><StreamProbe />
        </QueryClientProvider>
      </GatewayInstanceBoundary>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "fresh draft" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(readSettings).toHaveBeenCalledTimes(1);
    await act(async () => {
      if (trigger === "stream open") FakeEventSource.instances[0].onopen?.();
      else window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByText("Current native settings")).toBeInTheDocument();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => finishOld("Obsolete native settings"));
    expect(screen.queryByText("Obsolete native settings")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "edited draft" })).toBeInTheDocument();
    expect(readSettings).toHaveBeenCalledTimes(2);
  });

  it("recovers notification and device state in two tabs through stream open and foreground reads", async () => {
    let configured = true;
    let subscribed = true;
    const readStatus = vi.fn(async () => configured ? "Push configured" : "Push unavailable");
    const readDevice = vi.fn(async () => subscribed ? "Device enabled" : "Device disabled");
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("shared"));
    const tabs = [createKodexQueryClient(), createKodexQueryClient()].map((client) => render(
      <GatewayInstanceBoundary queryClient={client}>
        <QueryClientProvider client={client}>
          <SettingsProbe queryKey={queryKeys.notificationStatus} read={readStatus} />
          <SettingsProbe queryKey={["notifications", "current-device"]} read={readDevice} />
          <StreamProbe />
        </QueryClientProvider>
      </GatewayInstanceBoundary>,
    ));
    for (const tab of tabs) {
      expect(await within(tab.container).findByText("Push configured")).toBeInTheDocument();
      expect(await within(tab.container).findByText("Device enabled")).toBeInTheDocument();
    }
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(readStatus).toHaveBeenCalledTimes(2);
    expect(readDevice).toHaveBeenCalledTimes(2);
    configured = false;
    subscribed = false;

    await act(async () => FakeEventSource.instances[0].onopen?.());
    expect(await within(tabs[0].container).findByText("Device disabled")).toBeInTheDocument();
    expect(within(tabs[0].container).getByText("Push unavailable")).toBeInTheDocument();
    expect(within(tabs[1].container).getByText("Device enabled")).toBeInTheDocument();

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(await within(tabs[1].container).findByText("Device disabled")).toBeInTheDocument();
    expect(within(tabs[1].container).getByText("Push unavailable")).toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("refetches active account state on focus without resetting a same-instance draft", async () => {
    const queryClient = createKodexQueryClient();
    const readAccount = vi.fn().mockResolvedValue("Previous account state");
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    render(
      <GatewayInstanceBoundary queryClient={queryClient}>
        <QueryClientProvider client={queryClient}><AccountProbe read={readAccount} /><WorkspaceProbe /></QueryClientProvider>
      </GatewayInstanceBoundary>,
    );
    await screen.findByText("Previous account state");
    fireEvent.click(screen.getByRole("button", { name: "fresh draft" }));
    readAccount.mockResolvedValue("Updated account state");
    await act(async () => { window.dispatchEvent(new Event("focus")); });

    expect(await screen.findByText("Updated account state")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "edited draft" })).toBeInTheDocument();
  });

  it("makes two clients discard old replay cursors and selections when reconnect discovers a replacement", async () => {
    createInstanceStorage("first")?.setItem("selected-thread", "old-thread");
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("first"));
    const firstEvents = vi.fn();
    const secondEvents = vi.fn();
    const first = render(
      <GatewayInstanceBoundary queryClient={createKodexQueryClient()}>
        <WorkspaceProbe /><StreamProbe onEvent={firstEvents} />
      </GatewayInstanceBoundary>,
    );
    const second = render(
      <GatewayInstanceBoundary queryClient={createKodexQueryClient()}>
        <WorkspaceProbe /><StreamProbe onEvent={secondEvents} />
      </GatewayInstanceBoundary>,
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    fireEvent.click(within(first.container).getByRole("button", { name: "fresh draft" }));
    fireEvent.click(within(second.container).getByRole("button", { name: "fresh draft" }));
    const oldSources = [...FakeEventSource.instances];
    const pending: Array<(value: Capabilities) => void> = [];
    vi.mocked(getCapabilities).mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }));
    act(() => oldSources.forEach((source) => source.onerror?.()));
    await waitFor(() => expect(pending).toHaveLength(2));
    act(() => oldSources.forEach((source) => source.emit(1000)));

    expect(FakeEventSource.instances).toHaveLength(2);
    expect(firstEvents).not.toHaveBeenCalled();
    expect(secondEvents).not.toHaveBeenCalled();
    vi.mocked(getCapabilities).mockResolvedValue(capabilities("replacement"));
    await act(async () => pending.forEach((resolve) => resolve(capabilities("replacement"))));

    expect(await within(first.container).findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    expect(await within(second.container).findByRole("button", { name: "fresh draft" })).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(4));
    for (const source of FakeEventSource.instances.slice(2)) {
      const url = new URL(source.url, window.location.origin);
      expect(url.searchParams.has("cursor")).toBe(false);
      expect(url.searchParams.has("threadId")).toBe(false);
    }
    act(() => FakeEventSource.instances.slice(2).forEach((source) => source.emit(1)));
    expect(firstEvents).toHaveBeenCalledWith({ seq: 1 });
    expect(secondEvents).toHaveBeenCalledWith({ seq: 1 });
  });
});
