import { describe, expect, it, vi } from "vitest";

import {
  createExecutorFetch,
  executorApiUrl,
  executorWebSocketUrl,
  type ExecutorConnection,
} from "./executorConnection";

const connection: ExecutorConnection = {
  executorId: "executor/a",
  instanceId: "instance-a",
};

describe("executor connection transport", () => {
  it("qualifies generated gateway requests and binds the verified instance", async () => {
    const upstream = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://kodex.example/v1/executors/executor%2Fa/threads/native%2Fthread?limit=20");
      expect(request.headers.get("x-kodex-expected-instance")).toBe("instance-a");
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(request.method).toBe("POST");
      expect(await request.text()).toBe('{"message":"hello"}');
      return new Response(null, { status: 204 });
    });
    const scopedFetch = createExecutorFetch(connection, upstream, "https://kodex.example");

    const response = await scopedFetch(
      new Request("https://kodex.example/v1/threads/native%2Fthread?limit=20", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kodex-expected-instance": "stale-instance",
        },
        body: '{"message":"hello"}',
      }),
    );

    expect(response.status).toBe(204);
    expect(upstream).toHaveBeenCalledOnce();
  });

  it("builds qualified HTTP and WebSocket URLs without losing query data", () => {
    expect(executorApiUrl(connection, "/v1/events?cursor=7", "https://kodex.example")).toBe(
      "https://kodex.example/v1/executors/executor%2Fa/events?cursor=7",
    );
    expect(executorWebSocketUrl(connection, "/v1/terminals/terminal%2F1/ws?apiVersion=4", "https://kodex.example")).toBe(
      "wss://kodex.example/v1/executors/executor%2Fa/terminals/terminal%2F1/ws?apiVersion=4",
    );
  });

  it("rejects non-gateway and already-qualified paths", async () => {
    const upstream = vi.fn();
    const scopedFetch = createExecutorFetch(connection, upstream, "https://kodex.example");
    await expect(scopedFetch("https://kodex.example/healthz")).rejects.toThrow("unqualified /v1 route");
    await expect(scopedFetch("https://kodex.example/v1/executors/other/projects")).rejects.toThrow("already qualified");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects requests outside the configured federator origin", async () => {
    const upstream = vi.fn();
    const scopedFetch = createExecutorFetch(connection, upstream, "https://kodex.example");

    await expect(scopedFetch("https://other.example/v1/projects")).rejects.toThrow("configured federator origin");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("cannot be retargeted by mutating the source connection", async () => {
    const mutableConnection = { executorId: "executor-a", instanceId: "instance-a" };
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 204 })
    ));
    const scopedFetch = createExecutorFetch(mutableConnection, upstream, "https://kodex.example");
    mutableConnection.executorId = "executor-b";
    mutableConnection.instanceId = "instance-b";

    await scopedFetch("https://kodex.example/v1/projects");

    const request = new Request(upstream.mock.calls[0][0] as RequestInfo | URL);
    expect(request.url).toBe("https://kodex.example/v1/executors/executor-a/projects");
    expect(request.headers.get("x-kodex-expected-instance")).toBe("instance-a");
  });
});
