import { fireEvent, render, screen } from "@testing-library/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { GatewayClient } from "./gatewayClient";
import { createKodexQueryClient, type ExecutorRuntime } from "./queryClient";
import { createExecutorStorage } from "./instanceStorage";
import {
  ExecutorRuntimeProvider,
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

function runtime(id: string, api: GatewayClient): ExecutorRuntime {
  return {
    api,
    connection: Object.freeze({ executorId: id, instanceId: `instance-${id}` }),
    queryClient: createKodexQueryClient(),
    storage: null,
  };
}

describe("GatewayClientProvider", () => {
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
