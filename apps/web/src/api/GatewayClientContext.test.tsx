import { fireEvent, render, screen } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { GatewayClient } from "./gatewayClient";
import { createKodexQueryClient, type ExecutorRuntime } from "./queryClient";
import { createExecutorStorage } from "./instanceStorage";
import {
  ExecutorRuntimeBoundary,
  ExecutorRuntimeRegistryProvider,
  ExecutorRuntimeProvider,
  FederatedShellRuntimeProvider,
  GatewayClientProvider,
  useExecutorConnection,
  useGatewayClient,
  useGatewayInstanceStorage,
} from "./GatewayClientContext";

function ProjectButton() {
  const api = useGatewayClient();
  return <button onClick={() => void api.getProject("shared-project")}>Load</button>;
}

function ThreadActions() {
  const api = useGatewayClient();
  return <>
    <button onClick={() => void api.getThreadDetail("shared-thread")}>Read thread</button>
    <button onClick={() => void api.submitThreadInput("shared-thread", [{ type: "text", text: "Hello" }], [], "shared-attempt")}>Send</button>
  </>;
}

function RuntimeIdentity() {
  const connection = useExecutorConnection();
  const storage = useGatewayInstanceStorage();
  const [, refresh] = useState(0);
  return <button onClick={() => {
    storage?.setItem("workspace", connection?.executorId ?? "missing");
    refresh((value) => value + 1);
  }}>
    {connection?.executorId ?? "missing"}:{storage?.getItem("workspace") ?? "empty"}
  </button>;
}

function ProjectName() {
  const api = useGatewayClient();
  const query = useQuery({ queryKey: ["project"], queryFn: () => api.listProjects() });
  return <div>{query.data?.[0]?.name ?? "Loading"}</div>;
}

function StatefulProjectName() {
  return <><ProjectName /><input aria-label="unsent draft" defaultValue="" /></>;
}

function TransportProbe({ onClose }: { onClose: () => void }) {
  useEffect(() => onClose, [onClose]);
  return <p>Transport connected</p>;
}

function PreviewUrl() {
  const api = useGatewayClient();
  return <p>{api.filePreviewUrl("thread", "/tmp/image.png")}</p>;
}

function runtime(id: string, api: GatewayClient): ExecutorRuntime {
  return {
    api,
    connection: Object.freeze({ executorId: id, instanceId: `instance-${id}` }),
    queryClient: createKodexQueryClient(),
    storage: null,
  };
}

describe("GatewayClientProvider", () => {
  it("binds adjacent colliding resources through the pane executor runtime", () => {
    const first = { getThreadDetail: vi.fn(), submitThreadInput: vi.fn() } as unknown as GatewayClient;
    const second = { getThreadDetail: vi.fn(), submitThreadInput: vi.fn() } as unknown as GatewayClient;
    render(
      <ExecutorRuntimeRegistryProvider runtimes={[runtime("first", first), runtime("second", second)]}>
        <ExecutorRuntimeBoundary executorId="first"><ThreadActions /></ExecutorRuntimeBoundary>
        <ExecutorRuntimeBoundary executorId="second"><ThreadActions /></ExecutorRuntimeBoundary>
      </ExecutorRuntimeRegistryProvider>,
    );

    for (const button of screen.getAllByRole("button")) fireEvent.click(button);

    expect(first.getThreadDetail).toHaveBeenCalledWith("shared-thread");
    expect(second.getThreadDetail).toHaveBeenCalledWith("shared-thread");
    expect(first.submitThreadInput).toHaveBeenCalledTimes(1);
    expect(second.submitThreadInput).toHaveBeenCalledTimes(1);
  });

  it("keeps healthy executor content usable when an adjacent executor is unavailable", () => {
    const healthy = { getThreadDetail: vi.fn(), submitThreadInput: vi.fn() } as unknown as GatewayClient;
    render(
      <ExecutorRuntimeRegistryProvider runtimes={[runtime("healthy", healthy)]}>
        <ExecutorRuntimeBoundary executorId="healthy"><ThreadActions /></ExecutorRuntimeBoundary>
        <ExecutorRuntimeBoundary executorId="offline" fallback={<p>Executor unavailable</p>}><ThreadActions /></ExecutorRuntimeBoundary>
      </ExecutorRuntimeRegistryProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Read thread" }));
    expect(healthy.getThreadDetail).toHaveBeenCalledWith("shared-thread");
    expect(screen.getByText("Executor unavailable")).toBeVisible();
  });

  it("unmounts transport content when its executor becomes unavailable", () => {
    const close = vi.fn();
    const offline = runtime("offline", {} as GatewayClient);
    const view = render(
      <ExecutorRuntimeRegistryProvider availableExecutorIds={["offline"]} runtimes={[offline]}>
        <ExecutorRuntimeBoundary executorId="offline" fallback={<p>Executor unavailable</p>}>
          <TransportProbe onClose={close} />
        </ExecutorRuntimeBoundary>
      </ExecutorRuntimeRegistryProvider>,
    );
    expect(screen.getByText("Transport connected")).toBeInTheDocument();

    view.rerender(
      <ExecutorRuntimeRegistryProvider availableExecutorIds={[]} runtimes={[offline]}>
        <ExecutorRuntimeBoundary executorId="offline" fallback={<p>Executor unavailable</p>}>
          <TransportProbe onClose={close} />
        </ExecutorRuntimeBoundary>
      </ExecutorRuntimeRegistryProvider>,
    );

    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByText("Transport connected")).not.toBeInTheDocument();
    expect(screen.getByText("Executor unavailable")).toBeInTheDocument();
  });

  it("keeps pure qualified resource URLs available to a preserved offline editor", () => {
    const offline = runtime("offline", {
      filePreviewUrl: vi.fn(() => "/v1/executors/offline/threads/thread/files/preview"),
    } as unknown as GatewayClient);
    render(
      <ExecutorRuntimeRegistryProvider availableExecutorIds={[]} runtimes={[offline]}>
        <ExecutorRuntimeBoundary executorId="offline" preserveChildrenWhenUnavailable>
          <PreviewUrl />
        </ExecutorRuntimeBoundary>
      </ExecutorRuntimeRegistryProvider>,
    );

    expect(screen.getByText("/v1/executors/offline/threads/thread/files/preview")).toBeInTheDocument();
  });

  it("keeps adjacent trees bound to their owning clients", () => {
    const first = { getProject: vi.fn() } as unknown as GatewayClient;
    const second = { getProject: vi.fn() } as unknown as GatewayClient;
    render(
      <>
        <GatewayClientProvider client={first}><ProjectButton /></GatewayClientProvider>
        <GatewayClientProvider client={second}><ProjectButton /></GatewayClientProvider>
      </>,
    );

    const [firstButton, secondButton] = screen.getAllByRole("button", { name: "Load" });
    fireEvent.click(firstButton!);
    fireEvent.click(secondButton!);

    expect(first.getProject).toHaveBeenCalledWith("shared-project");
    expect(second.getProject).toHaveBeenCalledWith("shared-project");
  });

  it("routes colliding thread reads and sends through each owning client", () => {
    const first = { getThreadDetail: vi.fn(), submitThreadInput: vi.fn() } as unknown as GatewayClient;
    const second = { getThreadDetail: vi.fn(), submitThreadInput: vi.fn() } as unknown as GatewayClient;
    render(<>
      <GatewayClientProvider client={first}><ThreadActions /></GatewayClientProvider>
      <GatewayClientProvider client={second}><ThreadActions /></GatewayClientProvider>
    </>);

    for (const button of screen.getAllByRole("button")) fireEvent.click(button);

    expect(first.getThreadDetail).toHaveBeenCalledWith("shared-thread");
    expect(second.getThreadDetail).toHaveBeenCalledWith("shared-thread");
    expect(first.submitThreadInput).toHaveBeenCalledWith("shared-thread", [{ type: "text", text: "Hello" }], [], "shared-attempt");
    expect(second.submitThreadInput).toHaveBeenCalledWith("shared-thread", [{ type: "text", text: "Hello" }], [], "shared-attempt");
  });

  it("fails closed without an owning client", () => {
    expect(() => render(<ProjectButton />))
      .toThrow("Gateway client context is missing");
  });

  it("remounts client and cache together when the executor runtime changes", async () => {
    let releaseFirst!: (projects: Array<{ id: string; name: string }>) => void;
    const firstApi = {
      listProjects: vi.fn(() => new Promise((resolve) => { releaseFirst = resolve; })),
    } as unknown as GatewayClient;
    const secondApi = {
      listProjects: vi.fn(async () => [{ id: "shared", name: "Second executor" }]),
    } as unknown as GatewayClient;
    const first = runtime("first", firstApi);
    const second = runtime("second", secondApi);
    const view = render(<ExecutorRuntimeProvider runtime={first}><ProjectName /></ExecutorRuntimeProvider>);
    expect(await screen.findByText("Loading")).toBeVisible();

    view.rerender(<ExecutorRuntimeProvider runtime={second}><ProjectName /></ExecutorRuntimeProvider>);
    expect(await screen.findByText("Second executor")).toBeVisible();
    releaseFirst([{ id: "shared", name: "Late first executor" }]);
    await Promise.resolve();

    expect(screen.getByText("Second executor")).toBeVisible();
    expect(screen.queryByText("Late first executor")).not.toBeInTheDocument();
    expect(first.queryClient.getQueryData(["project"])).toBeUndefined();
    expect(second.queryClient.getQueryData(["project"])).toEqual([{ id: "shared", name: "Second executor" }]);
  });

  it("rebinds federated shell queries while preserving local editing state", async () => {
    let releaseFirst!: (projects: Array<{ id: string; name: string }>) => void;
    const firstListProjects = vi.fn(() => new Promise<Array<{ id: string; name: string }>>((resolve) => { releaseFirst = resolve; }));
    const secondListProjects = vi.fn(async () => [{ id: "shared", name: "Second executor" }]);
    const first = runtime("first", { listProjects: firstListProjects } as unknown as GatewayClient);
    const second = runtime("second", { listProjects: secondListProjects } as unknown as GatewayClient);
    const view = render(<FederatedShellRuntimeProvider runtime={first}><StatefulProjectName /></FederatedShellRuntimeProvider>);
    fireEvent.change(screen.getByRole("textbox", { name: "unsent draft" }), { target: { value: "keep me" } });

    view.rerender(<FederatedShellRuntimeProvider runtime={second}><StatefulProjectName /></FederatedShellRuntimeProvider>);
    expect(await screen.findByText("Second executor")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "unsent draft" })).toHaveValue("keep me");
    releaseFirst([{ id: "shared", name: "Late first executor" }]);
    await Promise.resolve();
    expect(screen.queryByText("Late first executor")).not.toBeInTheDocument();

    const secondCallCount = secondListProjects.mock.calls.length;
    view.rerender(<FederatedShellRuntimeProvider available={false} runtime={second}><StatefulProjectName /></FederatedShellRuntimeProvider>);
    expect(screen.getByRole("textbox", { name: "unsent draft" })).toHaveValue("keep me");
    await Promise.resolve();
    expect(secondListProjects).toHaveBeenCalledTimes(secondCallCount);
  });

  it("swaps executor identity and namespaced storage with the runtime", () => {
    const values = new Map<string, string>();
    const backing = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const api = {} as GatewayClient;
    const first = { ...runtime("first", api), storage: createExecutorStorage("first", "instance-first", backing) };
    const second = { ...runtime("second", api), storage: createExecutorStorage("second", "instance-second", backing) };
    const view = render(<ExecutorRuntimeProvider runtime={first}><RuntimeIdentity /></ExecutorRuntimeProvider>);

    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("first:first");
    view.rerender(<ExecutorRuntimeProvider runtime={second}><RuntimeIdentity /></ExecutorRuntimeProvider>);
    expect(screen.getByRole("button")).toHaveTextContent("second:empty");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("second:second");
    view.rerender(<ExecutorRuntimeProvider runtime={first}><RuntimeIdentity /></ExecutorRuntimeProvider>);
    expect(screen.getByRole("button")).toHaveTextContent("first:first");
  });
});
