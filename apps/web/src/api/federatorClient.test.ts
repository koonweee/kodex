import { afterEach, describe, expect, it, vi } from "vitest";

import { compatibilityRequired, resetCompatibilityForTests } from "./compatibility";
import {
  createFederationCatalogSubscription,
  createFederationRegistrySubscription,
  createFederatorClient,
  type ExecutorRegistryEvent,
} from "./federatorClient";

describe("federator client", () => {
  afterEach(() => {
    resetCompatibilityForTests();
    vi.unstubAllGlobals();
  });

  it("uses generated catalog routes and publishes typed catalog invalidations", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/move")) {
        return Response.json({ orderRevision: 3, items: [] }, { headers: { "x-kodex-api-version": "4" } });
      }
      return Response.json({ revision: 2, orderRevision: 2, projectOrder: [], pinnedOrder: [], executors: [] }, { headers: { "x-kodex-api-version": "4" } });
    }));
    const client = createFederatorClient({ baseUrl: "https://kodex.example" });
    await client.getCatalog();
    await client.refreshCatalog();
    await client.moveCatalogItem("project", {
      item: { executorId: "executor-a", nativeId: "project-a" },
      before: null,
      orderRevision: 2,
    });
    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/v1/federation/catalog"],
      ["POST", "/v1/federation/catalog"],
      ["POST", "/v1/federation/catalog/order/project/move"],
    ]);

    class FakeEventSource {
      static instance: FakeEventSource;
      listener?: (event: MessageEvent<string>) => void;
      constructor(readonly url: string) { FakeEventSource.instance = this; }
      addEventListener(_type: string, listener: (event: MessageEvent<string>) => void) { this.listener = listener; }
      close() {}
    }
    const onEvent = vi.fn();
    createFederationCatalogSubscription({ EventSourceCtor: FakeEventSource, onEvent });
    expect(FakeEventSource.instance.url).toBe("/v1/federation/catalog/events");
    FakeEventSource.instance.listener?.({ data: JSON.stringify({ revision: 4, orderRevision: 3 }) } as MessageEvent<string>);
    expect(onEvent).toHaveBeenCalledWith({ revision: 4, orderRevision: 3 });
  });

  it("uses the generated federation routes for registry reads and mutations", async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "DELETE") {
        return new Response(null, { status: 204, headers: { "x-kodex-api-version": "4" } });
      }
      if (request.url.endsWith("/v1/federation/executors") && request.method === "GET") {
        return Response.json({ revision: 3, executors: [] }, { headers: { "x-kodex-api-version": "4" } });
      }
      return Response.json({
        apiVersion: "4",
        appServerSchemaVersion: "0.160.0",
        baseUrl: "https://executor.tailnet.ts.net",
        createdAt: 1,
        displayName: "Build box",
        enabled: true,
        generation: 1,
        id: "executor-a",
        instanceId: "instance-a",
        lastSeenAt: 1,
        status: "ready",
        updatedAt: 1,
      }, { status: request.method === "POST" && !request.url.endsWith("/probe") ? 201 : 200, headers: { "x-kodex-api-version": "4" } });
    });
    vi.stubGlobal("fetch", fetch);
    const client = createFederatorClient({ baseUrl: "https://kodex.example" });

    await client.listExecutors();
    await client.registerExecutor({ displayName: "Build box", baseUrl: "https://executor.tailnet.ts.net" });
    await client.updateExecutor("executor-a", { displayName: "Renamed", enabled: false });
    await client.probeExecutor("executor-a");
    await client.removeExecutor("executor-a");

    expect(requests.map((request) => [request.method, new URL(request.url).pathname])).toEqual([
      ["GET", "/v1/federation/executors"],
      ["POST", "/v1/federation/executors"],
      ["PATCH", "/v1/federation/executors/executor-a"],
      ["POST", "/v1/federation/executors/executor-a/probe"],
      ["DELETE", "/v1/federation/executors/executor-a"],
    ]);
    expect(requests.every((request) => request.headers.get("x-kodex-api-version") === "4")).toBe(true);
    await expect(requests[1]!.json()).resolves.toEqual({
      displayName: "Build box",
      baseUrl: "https://executor.tailnet.ts.net",
    });
    await expect(requests[2]!.json()).resolves.toEqual({ displayName: "Renamed", enabled: false });
  });

  it("reports typed registry invalidations from the federator event stream", () => {
    class FakeEventSource {
      static instance: FakeEventSource;
      listeners = new Map<string, (event: MessageEvent<string>) => void>();
      closed = false;
      constructor(readonly url: string) { FakeEventSource.instance = this; }
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        this.listeners.set(type, listener);
      }
      close() { this.closed = true; }
      emit(type: string, value: ExecutorRegistryEvent) {
        this.listeners.get(type)?.({ data: JSON.stringify(value) } as MessageEvent<string>);
      }
    }
    const onEvent = vi.fn();
    const unsubscribe = createFederationRegistrySubscription({
      EventSourceCtor: FakeEventSource,
      onEvent,
    });

    expect(FakeEventSource.instance.url).toBe("/v1/federation/events");
    FakeEventSource.instance.emit("federation.executors_changed", {
      executorId: "executor-a",
      generation: 2,
      revision: 7,
    });
    expect(onEvent).toHaveBeenCalledWith({ executorId: "executor-a", generation: 2, revision: 7 });
    unsubscribe();
    expect(FakeEventSource.instance.closed).toBe(true);
  });

  it("shares the browser compatibility epoch with registry mutations", async () => {
    const fetch = vi.fn(async () => Response.json(
      { revision: 1, executors: [] },
      { headers: { "x-kodex-api-version": "5" } },
    ));
    vi.stubGlobal("fetch", fetch);
    const client = createFederatorClient({ baseUrl: "https://kodex.example" });

    await expect(client.listExecutors()).rejects.toThrow("Update Kodex");
    expect(compatibilityRequired()).toBe(true);
    await expect(client.registerExecutor({
      displayName: "Build box",
      baseUrl: "https://executor.tailnet.ts.net",
    })).rejects.toThrow("Update Kodex");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
