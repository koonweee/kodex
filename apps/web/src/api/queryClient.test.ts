import { afterEach, describe, expect, it, vi } from "vitest";

import type { FederatedExecutor, Project } from "./client";
import { resetCompatibilityForTests } from "./compatibility";
import { queryKeys } from "./queryKeys";
import { createExecutorRuntime, ExecutorRuntimeRegistry } from "./queryClient";

function executor(id: string, instanceId: string): FederatedExecutor {
  return {
    apiVersion: "4",
    appServerSchemaVersion: "0.160.0",
    baseUrl: `http://${id}.example`,
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

describe("executor runtime", () => {
  afterEach(() => {
    resetCompatibilityForTests();
    vi.unstubAllGlobals();
  });

  it("isolates API routing, query caches, and storage for colliding native IDs", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      return Response.json({
        id: "shared-project",
        name: request.url.includes("executor-a") ? "Project A" : "Project B",
        cwd: "/workspace",
      }, { headers: { "x-kodex-api-version": "4" } });
    }));
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const first = createExecutorRuntime(executor("executor-a", "instance-a"), {
      baseUrl: "https://kodex.example",
      storage,
    });
    const second = createExecutorRuntime(executor("executor-b", "instance-b"), {
      baseUrl: "https://kodex.example",
      storage,
    });
    first.queryClient.setQueryData<Project[]>(queryKeys.projects, [{ id: "shared-project", name: "Cached A" } as Project]);
    second.queryClient.setQueryData<Project[]>(queryKeys.projects, [{ id: "shared-project", name: "Cached B" } as Project]);
    first.storage?.setItem("draft", "Draft A");
    second.storage?.setItem("draft", "Draft B");

    await expect(first.api.getProject("shared-project")).resolves.toMatchObject({ name: "Project A" });
    await expect(second.api.getProject("shared-project")).resolves.toMatchObject({ name: "Project B" });
    expect(first.queryClient.getQueryData<Project[]>(queryKeys.projects)?.[0]?.name).toBe("Cached A");
    expect(second.queryClient.getQueryData<Project[]>(queryKeys.projects)?.[0]?.name).toBe("Cached B");
    expect(first.storage?.getItem("draft")).toBe("Draft A");
    expect(second.storage?.getItem("draft")).toBe("Draft B");
    expect([...values.keys()]).toEqual([
      "kodex.executor.executor-a.instance-a:draft",
      "kodex.executor.executor-b.instance-b:draft",
    ]);
  });

  it("snapshots registry identity when the runtime is created", () => {
    const source = executor("executor-a", "instance-a");
    const runtime = createExecutorRuntime(source, { baseUrl: "https://kodex.example", storage: null });
    source.id = "executor-b";
    source.instanceId = "instance-b";

    expect(runtime.connection).toEqual({ executorId: "executor-a", instanceId: "instance-a" });
  });

  it("reuses runtime resources while publishing fresh same-instance metadata", async () => {
    const registry = new ExecutorRuntimeRegistry({ baseUrl: "https://kodex.example", storage: null });
    const [initial] = await registry.synchronize({ revision: 1, executors: [executor("executor-a", "instance-a")] });
    initial.runtime.queryClient.setQueryData(queryKeys.projects, [{ id: "cached" }]);

    const [updated] = await registry.synchronize({ revision: 2, executors: [{
      ...executor("executor-a", "instance-a"),
      displayName: "Renamed executor",
      generation: 4,
      status: "unready",
    }] });

    expect(updated.runtime).toBe(initial.runtime);
    expect(updated.executor).toMatchObject({
      displayName: "Renamed executor",
      generation: 4,
      status: "unready",
    });
    expect(updated.runtime.queryClient.getQueryData(queryKeys.projects)).toEqual([{ id: "cached" }]);
  });

  it("disposes removed or replaced instance caches", async () => {
    const registry = new ExecutorRuntimeRegistry({ baseUrl: "https://kodex.example", storage: null });
    const [initial] = await registry.synchronize({ revision: 1, executors: [executor("executor-a", "instance-a")] });
    initial.runtime.queryClient.setQueryData(queryKeys.projects, [{ id: "old" }]);

    const [replacement] = await registry.synchronize({ revision: 2, executors: [executor("executor-a", "instance-b")] });

    expect(replacement.runtime).not.toBe(initial.runtime);
    expect(replacement.runtime.connection.instanceId).toBe("instance-b");
    expect(initial.runtime.queryClient.getQueryData(queryKeys.projects)).toBeUndefined();
    expect(replacement.runtime.queryClient.getQueryData(queryKeys.projects)).toBeUndefined();

    replacement.runtime.queryClient.setQueryData(queryKeys.projects, [{ id: "replacement" }]);
    await registry.synchronize({ revision: 3, executors: [] });
    expect(registry.get("executor-a")).toBeUndefined();
    expect(replacement.runtime.queryClient.getQueryData(queryKeys.projects)).toBeUndefined();
  });

  it("serializes overlapping snapshots and ignores stale revisions", async () => {
    const registry = new ExecutorRuntimeRegistry({ baseUrl: "https://kodex.example", storage: null });
    const [initial] = await registry.synchronize({ revision: 1, executors: [executor("executor-a", "instance-a")] });
    let release!: () => void;
    const originalCancel = initial.runtime.queryClient.cancelQueries.bind(initial.runtime.queryClient);
    vi.spyOn(initial.runtime.queryClient, "cancelQueries").mockImplementation(async (...args) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return originalCancel(...args);
    });

    const removal = registry.synchronize({ revision: 2, executors: [] });
    const restored = registry.synchronize({
      revision: 3,
      executors: [{ ...executor("executor-a", "instance-a"), displayName: "Newest" }],
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await removal;
    const [current] = await restored;

    expect(current.executor.displayName).toBe("Newest");
    expect(current.runtime).not.toBe(initial.runtime);
    const stale = await registry.synchronize({
      revision: 2,
      executors: [{ ...executor("executor-a", "instance-a"), displayName: "Stale" }],
    });
    expect(stale[0]).toBe(current);
    expect(registry.get("executor-a")).toBe(current);
  });

  it("captures queued snapshots before callers can mutate them", async () => {
    const registry = new ExecutorRuntimeRegistry({ baseUrl: "https://kodex.example", storage: null });
    const [initial] = await registry.synchronize({ revision: 1, executors: [executor("executor-a", "instance-a")] });
    let release!: () => void;
    vi.spyOn(initial.runtime.queryClient, "cancelQueries").mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
    });

    const removal = registry.synchronize({ revision: 2, executors: [] });
    const queued = {
      revision: 3,
      executors: [{ ...executor("executor-b", "instance-b"), displayName: "Captured" }],
    };
    const submitted = registry.synchronize(queued);
    queued.revision = 99;
    queued.executors[0]!.id = "mutated-id";
    queued.executors[0]!.instanceId = "mutated-instance";
    queued.executors[0]!.displayName = "Mutated";

    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await removal;
    const [current] = await submitted;

    expect(current.executor).toMatchObject({
      id: "executor-b",
      instanceId: "instance-b",
      displayName: "Captured",
    });
    expect(registry.get("executor-b")).toBe(current);
    expect(registry.get("mutated-id")).toBeUndefined();
    await expect(registry.synchronize({
      revision: 4,
      executors: [{ ...executor("executor-b", "instance-b"), displayName: "Revision Four" }],
    })).resolves.toEqual([
      expect.objectContaining({ executor: expect.objectContaining({ displayName: "Revision Four" }) }),
    ]);
  });
});
