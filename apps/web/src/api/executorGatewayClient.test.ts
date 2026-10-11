import { afterEach, describe, expect, it, vi } from "vitest";
import { File as NodeFile } from "node:buffer";

import { createExecutorGatewayClient } from "./client";

describe("executor gateway client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps colliding native IDs on their owning executor", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return Response.json({
        id: "shared-project",
        name: request.url.includes("executor-a") ? "Project A" : "Project B",
        cwd: "/workspace",
      }, { headers: { "x-kodex-api-version": "4" } });
    });
    const first = createExecutorGatewayClient(
      { executorId: "executor-a", instanceId: "instance-a" },
      { baseUrl: "https://kodex.example", fetch },
    );
    const second = createExecutorGatewayClient(
      { executorId: "executor-b", instanceId: "instance-b" },
      { baseUrl: "https://kodex.example", fetch },
    );

    await expect(first.getProject("shared-project")).resolves.toMatchObject({ name: "Project A" });
    await expect(second.getProject("shared-project")).resolves.toMatchObject({ name: "Project B" });
    expect(fetch.mock.calls.map(([input, init]) => new Request(input, init).url)).toEqual([
      "https://kodex.example/v1/executors/executor-a/projects/shared-project",
      "https://kodex.example/v1/executors/executor-b/projects/shared-project",
    ]);
  });

  it("qualifies resource and WebSocket URLs", () => {
    const client = createExecutorGatewayClient(
      { executorId: "executor/a", instanceId: "instance-a" },
      { baseUrl: "https://kodex.example", fetch: vi.fn() },
    );

    expect(client.filePreviewUrl("thread/1", "notes.md")).toBe(
      "https://kodex.example/v1/executors/executor%2Fa/threads/thread%2F1/files/preview?path=notes.md",
    );
    expect(client.skillIconUrl("icons/skill.svg")).toBe(
      "https://kodex.example/v1/executors/executor%2Fa/skills/icon?path=icons%2Fskill.svg",
    );
    expect(client.terminalWebSocketUrl("terminal/1")).toBe(
      "wss://kodex.example/v1/executors/executor%2Fa/terminals/terminal%2F1/ws?apiVersion=4",
    );
  });

  it("qualifies manual preview and multipart requests exactly once", async () => {
    const requests: Request[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: Request) => {
      requests.push(request);
      if (request.url.includes("/files/preview")) return new Response("preview");
      if (request.url.endsWith("/uploads/images")) return Response.json({ images: [] });
      return Response.json({ files: [] });
    }));
    const client = createExecutorGatewayClient(
      { executorId: "executor-a", instanceId: "instance-a" },
      { baseUrl: "https://kodex.example" },
    );
    const image = new NodeFile(["image"], "image.png", { type: "image/png" }) as unknown as File;
    const notes = new NodeFile(["notes"], "notes.md", { type: "text/markdown" }) as unknown as File;

    await expect(client.fetchThreadFilePreview("thread/1", "notes.md")).resolves.toBe("preview");
    await expect(client.uploadImages([image])).resolves.toEqual([]);
    await expect(client.uploadFiles("thread/1", [notes])).resolves.toEqual([]);

    expect(requests.map((request) => request.url)).toEqual([
      "https://kodex.example/v1/executors/executor-a/threads/thread%2F1/files/preview?path=notes.md",
      "https://kodex.example/v1/executors/executor-a/uploads/images",
      "https://kodex.example/v1/executors/executor-a/threads/thread%2F1/uploads/files",
    ]);
    for (const request of requests) {
      expect(request.headers.get("x-kodex-api-version")).toBe("4");
      expect(request.headers.get("x-kodex-expected-instance")).toBe("instance-a");
    }
    expect(Array.from((await requests[1].clone().formData()).entries())).toHaveLength(1);
    expect(Array.from((await requests[2].clone().formData()).entries())).toHaveLength(1);
  });

  it("uses a versioned scoped keepalive PUT for page-exit presence", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => (
      new Response(null, { status: 204 })
    ));
    vi.stubGlobal("fetch", fetch);
    const client = createExecutorGatewayClient(
      { executorId: "executor-a", instanceId: "instance-a" },
      { baseUrl: "https://kodex.example" },
    );

    expect(client.sendThreadViewPresenceSnapshotBeacon({ clientId: "tab", visibleThreadIds: [] })).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();

    const request = fetch.mock.calls[0][0] as Request;
    expect(request.url).toBe("https://kodex.example/v1/executors/executor-a/thread-view-presence");
    expect(request.method).toBe("PUT");
    expect(request.keepalive).toBe(true);
    expect(request.headers.get("x-kodex-api-version")).toBe("4");
    expect(request.headers.get("x-kodex-expected-instance")).toBe("instance-a");
  });
});
