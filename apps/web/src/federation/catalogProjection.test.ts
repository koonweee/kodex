import { describe, expect, it } from "vitest";

import type { FederatedCatalog } from "../api/federatorClient";
import { buildFederatedCatalogProjection, catalogTargetKey, parseCatalogTargetKey } from "./catalogProjection";

function project(id: string, name: string) {
  return { id, name, roots: [{ path: `/${id}` }], metadata: {}, position: 0, createdAt: 1, updatedAt: 1, recencyAt: null };
}

function thread(id: string, projectId: string | null, name: string) {
  return {
    id, projectId, name, preview: name, createdAt: 1, updatedAt: 1, cwd: "/workspace", status: "idle" as const,
    parentThreadId: null, canAcceptDirectInput: null, notificationsEnabled: true, pinned: false,
    latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: true,
    unreadCompletedAgentTurn: false,
  };
}

function catalog(): FederatedCatalog {
  const aProject = project("shared", "Alpha project");
  const bProject = project("shared", "Beta project");
  const aPinned = thread("shared-thread", null, "Alpha pin");
  const bPinned = thread("shared-thread", "shared", "Beta pin");
  return {
    revision: 8,
    orderRevision: 5,
    projectOrder: [
      { executorId: "beta", nativeId: "shared" },
      { executorId: "alpha", nativeId: "shared" },
    ],
    pinnedOrder: [
      { executorId: "alpha", nativeId: "shared-thread" },
      { executorId: "beta", nativeId: "shared-thread" },
    ],
    executors: [
      {
        executorId: "alpha", executorName: "Alpha Mac", generation: 1, observedAt: 100, stale: false,
        snapshot: {
          projects: [aProject],
          projectThreads: { shared: { threads: [thread("project-thread", "shared", "Alpha work")], nextCursor: null } },
          chatThreads: { threads: [thread("chat", null, "Alpha chat")], nextCursor: null },
          pinnedThreads: { threads: [aPinned], nextCursor: null },
        },
      },
      {
        executorId: "beta", executorName: "Beta Linux", generation: 2, observedAt: 90, stale: true,
        snapshot: {
          projects: [bProject],
          projectThreads: { shared: { threads: [thread("project-thread", "shared", "Beta work")], nextCursor: null } },
          chatThreads: { threads: [thread("chat", null, "Beta chat")], nextCursor: "more" },
          pinnedThreads: { threads: [bPinned], nextCursor: null },
        },
      },
    ],
  };
}

describe("federated catalog projection", () => {
  it("keeps colliding native IDs distinct and applies global project and pin order", () => {
    const projection = buildFederatedCatalogProjection(catalog());

    expect(projection.projects.map((entry) => [entry.executorName, entry.project.name])).toEqual([
      ["Beta Linux", "Beta project"],
      ["Alpha Mac", "Alpha project"],
    ]);
    expect(projection.pinnedThreads.map((entry) => [entry.executorName, entry.thread.name])).toEqual([
      ["Alpha Mac", "Alpha pin"],
      ["Beta Linux", "Beta pin"],
    ]);
    expect(projection.projects[0]?.key).not.toBe(projection.projects[1]?.key);
    expect(projection.pinnedThreads[0]?.key).not.toBe(projection.pinnedThreads[1]?.key);
    expect(projection.projectThreadsByProjectKey[projection.projects[0]!.key]?.[0]?.thread.name).toBe("Beta work");
    expect(projection.chatThreads.map((entry) => entry.thread.name)).toEqual(["Alpha chat", "Beta chat"]);
    expect(projection.projects[0]?.stale).toBe(true);
  });

  it("filters without changing qualified identity or source freshness", () => {
    const projection = buildFederatedCatalogProjection(catalog(), "beta");

    expect(projection.projects.map((entry) => entry.executorId)).toEqual(["beta"]);
    expect(projection.pinnedThreads.map((entry) => entry.executorId)).toEqual(["beta"]);
    expect(projection.chatThreads.map((entry) => entry.executorId)).toEqual(["beta"]);
    expect(projection.executors).toEqual([
      expect.objectContaining({ executorId: "alpha", included: false, stale: false }),
      expect.objectContaining({ executorId: "beta", included: true, stale: true }),
    ]);
  });

  it("round trips IDs that contain separators", () => {
    const key = catalogTargetKey({ executorId: "mac:one", nativeId: "thread/one:two" });
    expect(parseCatalogTargetKey(key)).toEqual({ executorId: "mac:one", nativeId: "thread/one:two" });
    expect(parseCatalogTargetKey("not-a-qualified-target")).toBeNull();
  });
});
