import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FederatedExecutor, FederatedExecutorListResponse } from "./client";
import { FederatedInstanceBoundary } from "./FederatedInstanceBoundary";
import { ExecutorRuntimeRegistry } from "./queryClient";

function executor(id: string, instanceId: string): FederatedExecutor {
  return {
    apiVersion: "4",
    appServerSchemaVersion: "0.160.0",
    baseUrl: `https://${id}.example`,
    createdAt: 1,
    displayName: id,
    enabled: true,
    generation: 1,
    id,
    instanceId,
    lastError: null,
    lastSeenAt: 1,
    status: "ready",
    updatedAt: 1,
  };
}

describe("federated instance bootstrap", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/executors/executor-b/threads/shared");
  });

  it("selects the executor named by the deep link and exposes every registered runtime", async () => {
    const snapshot: FederatedExecutorListResponse = {
      revision: 1,
      executors: [executor("executor-a", "instance-a"), executor("executor-b", "instance-b")],
    };
    const client = {
      getHealth: vi.fn().mockResolvedValue({ instanceId: "federator-1", ready: true, service: "kodex-federator" }),
      listExecutors: vi.fn().mockResolvedValue(snapshot),
    };
    const registry = new ExecutorRuntimeRegistry({ baseUrl: window.location.origin, storage: null });

    render(
      <FederatedInstanceBoundary client={client} registry={registry} subscribe={() => () => undefined}>
        {({ defaultRuntime, runtimes }) => (
          <p>{defaultRuntime.connection.executorId}:{runtimes.map((runtime) => runtime.connection.executorId).join(",")}</p>
        )}
      </FederatedInstanceBoundary>,
    );

    expect(await screen.findByText("executor-b:executor-a,executor-b")).toBeInTheDocument();
  });

  it("keeps the mounted shell runtime stable on qualified popstate without rebasing the URL", async () => {
    const snapshot: FederatedExecutorListResponse = {
      revision: 1,
      executors: [executor("executor-a", "instance-a"), executor("executor-b", "instance-b")],
    };
    const client = {
      getHealth: vi.fn().mockResolvedValue({ instanceId: "federator-1", ready: true, service: "kodex-federator" }),
      listExecutors: vi.fn().mockResolvedValue(snapshot),
    };

    render(
      <FederatedInstanceBoundary
        client={client}
        registry={new ExecutorRuntimeRegistry({ baseUrl: window.location.origin, storage: null })}
        subscribe={() => () => undefined}
      >
        {({ defaultRuntime, routeAvailable }) => <p>{defaultRuntime.connection.executorId}:{String(routeAvailable)}</p>}
      </FederatedInstanceBoundary>,
    );
    expect(await screen.findByText("executor-b:true")).toBeInTheDocument();

    window.history.pushState(null, "", "/executors/executor-a/threads/shared");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(await screen.findByText("executor-b:true")).toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/executors/executor-a/threads/shared"));

    window.history.pushState(null, "", "/executors/missing/threads/shared");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(await screen.findByText("executor-b:false")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/executors/missing/threads/shared");
  });

  it("rejects cross-executor non-thread popstate routes instead of exposing the old shell under the new URL", async () => {
    const client = {
      getHealth: vi.fn().mockResolvedValue({ instanceId: "federator-1", ready: true, service: "kodex-federator" }),
      listExecutors: vi.fn().mockResolvedValue({
        revision: 1,
        executors: [executor("executor-a", "instance-a"), executor("executor-b", "instance-b")],
      }),
    };

    render(
      <FederatedInstanceBoundary
        client={client}
        registry={new ExecutorRuntimeRegistry({ baseUrl: window.location.origin, storage: null })}
        subscribe={() => () => undefined}
      >
        {({ routeError }) => <p>{routeError ?? "ready"}</p>}
      </FederatedInstanceBoundary>,
    );
    expect(await screen.findByText("ready")).toBeInTheDocument();

    window.history.pushState(null, "", "/executors/executor-a/projects/shared");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(await screen.findByText(/open executor executor-a .* in a new tab/i)).toBeInTheDocument();
    expect(window.location.pathname).toBe("/executors/executor-b/threads/shared");
  });

  it("replaces the retained shell runtime when the binding gets a new instance", async () => {
    window.history.replaceState(null, "", "/executors/executor-a");
    let snapshot: FederatedExecutorListResponse = {
      revision: 1,
      executors: [executor("executor-a", "instance-a")],
    };
    let publish: (event: { revision: number }) => void = () => undefined;
    const client = {
      getHealth: vi.fn().mockResolvedValue({ instanceId: "federator-1", ready: true, service: "kodex-federator" }),
      listExecutors: vi.fn(async () => snapshot),
    };

    render(
      <FederatedInstanceBoundary
        client={client}
        registry={new ExecutorRuntimeRegistry({ baseUrl: window.location.origin, storage: null })}
        subscribe={({ onEvent }) => { publish = onEvent; return () => undefined; }}
      >
        {({ defaultRuntime }) => <p>{defaultRuntime.connection.instanceId}</p>}
      </FederatedInstanceBoundary>,
    );
    expect(await screen.findByText("instance-a")).toBeInTheDocument();

    snapshot = {
      revision: 2,
      executors: [{ ...executor("executor-a", "instance-b"), generation: 2 }],
    };
    publish({ revision: 2 });

    expect(await screen.findByText("instance-b")).toBeInTheDocument();
    expect(screen.queryByText("instance-a")).not.toBeInTheDocument();
  });

  it("mounts a healthy shell while marking an unavailable qualified link as unroutable", async () => {
    const client = {
      getHealth: vi.fn().mockResolvedValue({ instanceId: "federator-1", ready: true, service: "kodex-federator" }),
      listExecutors: vi.fn().mockResolvedValue({
        revision: 1,
        executors: [executor("executor-a", "instance-a")],
      }),
    };

    render(
      <FederatedInstanceBoundary
        client={client}
        registry={new ExecutorRuntimeRegistry({ baseUrl: window.location.origin, storage: null })}
        subscribe={() => () => undefined}
      >
        {({ defaultRuntime, routeError }) => <p>{defaultRuntime.connection.executorId}:{routeError}</p>}
      </FederatedInstanceBoundary>,
    );

    expect(await screen.findByText("executor-a:Executor executor-b is unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/executors/executor-b/threads/shared");
  });

  it("creates one stable production client instead of refetching after its own state update", async () => {
    window.history.replaceState(null, "", "/executors/executor-a");
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path === "/healthz") return Response.json({ instanceId: "federator-1", ready: true, service: "kodex-federator" });
      if (path === "/v1/federation/executors") return Response.json({ revision: 1, executors: [executor("executor-a", "instance-a")] });
      return Response.json({}, { status: 404 });
    });

    render(
      <FederatedInstanceBoundary subscribe={() => () => undefined}>
        {({ defaultRuntime }) => <p>{defaultRuntime.connection.executorId}</p>}
      </FederatedInstanceBoundary>,
    );

    expect(await screen.findByText("executor-a")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps the mounted workspace and healthy runtimes after selected-executor removal or refresh failure", async () => {
    window.history.replaceState(null, "", "/executors/executor-a/threads/shared");
    let snapshot: FederatedExecutorListResponse = {
      revision: 1,
      executors: [executor("executor-a", "instance-a"), executor("executor-b", "instance-b")],
    };
    let fail = false;
    let publish: (event: { revision: number }) => void = () => {
      throw new Error("registry subscription was not installed");
    };
    const client = {
      getHealth: vi.fn().mockResolvedValue({ instanceId: "federator-1", ready: true, service: "kodex-federator" }),
      listExecutors: vi.fn(async () => {
        if (fail) throw new Error("offline");
        return snapshot;
      }),
    };

    render(
      <FederatedInstanceBoundary
        client={client}
        registry={new ExecutorRuntimeRegistry({ baseUrl: window.location.origin, storage: null })}
        subscribe={({ onEvent }) => { publish = onEvent; return () => undefined; }}
      >
        {({ defaultRuntime, defaultRuntimeAvailable, runtimes }) => (
          <label>
            {defaultRuntime.connection.executorId}:{runtimes.map((runtime) => runtime.connection.executorId).join(",")}:{String(defaultRuntimeAvailable)}
            <input aria-label="unsent draft" />
          </label>
        )}
      </FederatedInstanceBoundary>,
    );

    expect(await screen.findByText(/executor-a:executor-a,executor-b:true/)).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox", { name: "unsent draft" }), "keep me");

    snapshot = {
      revision: 2,
      executors: [{ ...executor("executor-a", "instance-a"), enabled: false }, executor("executor-b", "instance-b")],
    };
    publish({ revision: 2 });
    expect(await screen.findByText(/executor-a:executor-a,executor-b:false/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "unsent draft" })).toHaveValue("keep me");

    snapshot = {
      revision: 3,
      executors: [{ ...executor("executor-a", "instance-a"), enabled: false }],
    };
    publish({ revision: 3 });
    expect(await screen.findByText(/executor-a:executor-a,executor-b:false/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "unsent draft" })).toHaveValue("keep me");

    fail = true;
    publish({ revision: 4 });
    await waitFor(() => expect(client.listExecutors).toHaveBeenCalledTimes(4));
    expect(screen.getByText(/executor-a:executor-a,executor-b:false/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "unsent draft" })).toHaveValue("keep me");
  });

  it("excludes disabled and incompatible executors from routable runtimes", async () => {
    window.history.replaceState(null, "", "/executors/executor-a");
    const disabled = { ...executor("executor-a", "instance-a"), enabled: false };
    const incompatible = { ...executor("executor-c", "instance-c"), status: "incompatible" as const };
    const client = {
      getHealth: vi.fn().mockResolvedValue({ instanceId: "federator-1", ready: true, service: "kodex-federator" }),
      listExecutors: vi.fn().mockResolvedValue({
        revision: 1,
        executors: [disabled, executor("executor-b", "instance-b"), incompatible],
      }),
    };

    render(
      <FederatedInstanceBoundary
        client={client}
        registry={new ExecutorRuntimeRegistry({ baseUrl: window.location.origin, storage: null })}
        subscribe={() => () => undefined}
      >
        {({ availableExecutorIds, defaultRuntime, routeError, runtimes }) => (
          <p>{defaultRuntime.connection.executorId}:{availableExecutorIds.join(",")}:{runtimes.map((runtime) => runtime.connection.executorId).join(",")}:{routeError}</p>
        )}
      </FederatedInstanceBoundary>,
    );

    expect(await screen.findByText("executor-b:executor-b:executor-a,executor-b,executor-c:Executor executor-a is unavailable.")).toBeInTheDocument();
  });

  it("rejects an unqualified legacy thread route in the federated shell", async () => {
    window.history.replaceState(null, "", "/threads/shared");
    const client = {
      getHealth: vi.fn().mockResolvedValue({ instanceId: "federator-1", ready: true, service: "kodex-federator" }),
      listExecutors: vi.fn().mockResolvedValue({
        revision: 1,
        executors: [executor("executor-a", "instance-a"), executor("executor-b", "instance-b")],
      }),
    };

    render(
      <FederatedInstanceBoundary
        client={client}
        registry={new ExecutorRuntimeRegistry({ baseUrl: window.location.origin, storage: null })}
        subscribe={() => () => undefined}
      >
        {() => <p>mounted</p>}
      </FederatedInstanceBoundary>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("must name an executor");
    expect(screen.queryByText("mounted")).not.toBeInTheDocument();
    expect(window.location.pathname).toBe("/threads/shared");
  });

  it("bootstraps persisted executors whose readiness reset to unknown after restart", async () => {
    window.history.replaceState(null, "", "/executors/executor-a");
    const recovering = {
      ...executor("executor-a", "instance-a"),
      lastError: "Executor has not been checked since federator restart.",
      status: "unknown" as const,
    };
    const client = {
      getHealth: vi.fn().mockResolvedValue({ instanceId: "federator-1", ready: true, service: "kodex-federator" }),
      listExecutors: vi.fn().mockResolvedValue({ revision: 1, executors: [recovering] }),
    };

    render(
      <FederatedInstanceBoundary
        client={client}
        registry={new ExecutorRuntimeRegistry({ baseUrl: window.location.origin, storage: null })}
        subscribe={() => () => undefined}
      >
        {({ defaultRuntime }) => <p>{defaultRuntime.connection.executorId}</p>}
      </FederatedInstanceBoundary>,
    );

    expect(await screen.findByText("executor-a")).toBeInTheDocument();
  });

  it("gates known unready and failed executors while keeping a ready sibling usable", async () => {
    window.history.replaceState(null, "", "/executors/executor-b/threads/shared");
    const unready = { ...executor("executor-b", "instance-b"), status: "unready" as const };
    const failed = {
      ...executor("executor-c", "instance-c"),
      lastError: "connection refused",
      status: "unknown" as const,
    };
    const client = {
      getHealth: vi.fn().mockResolvedValue({ instanceId: "federator-1", ready: true, service: "kodex-federator" }),
      listExecutors: vi.fn().mockResolvedValue({
        revision: 1,
        executors: [executor("executor-a", "instance-a"), unready, failed],
      }),
    };

    render(
      <FederatedInstanceBoundary
        client={client}
        registry={new ExecutorRuntimeRegistry({ baseUrl: window.location.origin, storage: null })}
        subscribe={() => () => undefined}
      >
        {({ availableExecutorIds, defaultRuntime, routeError }) => (
          <p>{defaultRuntime.connection.executorId}:{availableExecutorIds.join(",")}:{routeError}</p>
        )}
      </FederatedInstanceBoundary>,
    );

    expect(await screen.findByText("executor-a:executor-a:Executor executor-b is unavailable.")).toBeInTheDocument();
  });
});
