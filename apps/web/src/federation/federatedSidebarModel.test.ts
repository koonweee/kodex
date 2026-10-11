import { describe, expect, it } from "vitest";

import type { FederatedCatalog } from "../api/federatorClient";
import { buildFederatedSidebarModel, resolveActionableCatalogExecutorIds } from "./federatedSidebarModel";

const thread = (id: string, projectId: string | null, name: string, pinned = false) => ({
  id, projectId, name, preview: name, createdAt: 1, updatedAt: 1, cwd: "/workspace", status: "idle" as const,
  parentThreadId: null, canAcceptDirectInput: null, notificationsEnabled: true, pinned,
  latestCompletedTurnId: null, seenCompletedTurnId: null, readRevision: 0, readStateKnown: true,
  unreadCompletedAgentTurn: false,
});

const catalog: FederatedCatalog = {
  revision: 2,
  orderRevision: 4,
  projectOrder: [{ executorId: "linux", nativeId: "project" }, { executorId: "mac", nativeId: "project" }],
  pinnedOrder: [{ executorId: "linux", nativeId: "pin" }, { executorId: "mac", nativeId: "pin" }],
  executors: ["mac", "linux"].map((executorId, index) => ({
    executorId,
    executorName: executorId === "mac" ? "Desk Mac" : "Build Linux",
    generation: 1,
    observedAt: 10 - index,
    stale: executorId === "linux",
    snapshot: {
      projects: [{ id: "project", name: `${executorId} project`, roots: [{ path: "/workspace" }], metadata: {}, position: 0, createdAt: 1, updatedAt: 1, recencyAt: null }],
      projectThreads: { project: { threads: [thread("work", "project", `${executorId} work`)], nextCursor: null } },
      chatThreads: { threads: [thread("chat", null, `${executorId} chat`)], nextCursor: null },
      pinnedThreads: { threads: [thread("pin", null, `${executorId} pin`, true)], nextCursor: null },
    },
  })),
};

describe("federated sidebar model", () => {
  it("adapts qualified catalog rows to the existing sidebar without losing native targets", () => {
    const model = buildFederatedSidebarModel(catalog, new Set(["mac"]));

    expect(model.projects.map((project) => project.name)).toEqual(["linux project", "mac project"]);
    expect(model.pinnedThreads.map((entry) => entry.name)).toEqual(["linux pin", "mac pin"]);
    expect(model.resolveTarget(model.projects[0]!.id)).toEqual({ executorId: "linux", nativeId: "project" });
    expect(model.resolveTarget(model.pinnedThreads[1]!.id)).toEqual({ executorId: "mac", nativeId: "pin" });
    expect(model.contextById[model.projects[0]!.id]).toEqual({
      actionable: false, available: false, executorName: "Build Linux", observedAt: 9, stale: true,
    });
    expect(model.threadsByProjectId[model.projects[0]!.id]?.[0]?.projectId).toBe(model.projects[0]!.id);
    expect(model.threadsByProjectId[model.projects[0]!.id]?.[0]?.id).not.toBe(model.threadsByProjectId[model.projects[1]!.id]?.[0]?.id);
  });

  it("applies the executor filter while retaining the full filter option list", () => {
    const model = buildFederatedSidebarModel(catalog, new Set(["mac", "linux"]), new Set(["mac"]), "mac");

    expect(model.projects).toHaveLength(1);
    expect(model.chatThreads).toHaveLength(1);
    expect(model.pinnedThreads).toHaveLength(1);
    expect(model.executors.map((entry) => [entry.executorId, entry.included])).toEqual([["mac", true], ["linux", false]]);
  });

  it("does not authorize cached rows after an executor binding is replaced", () => {
    const ids = resolveActionableCatalogExecutorIds(catalog, [{
      apiVersion: "4", appServerSchemaVersion: "0.160.0", baseUrl: "https://mac.example", createdAt: 1,
      displayName: "Desk Mac", enabled: true, generation: 2, id: "mac", instanceId: "new-instance",
      lastError: null, lastSeenAt: 1, status: "ready", updatedAt: 1,
    }], new Set(["mac"]));

    expect(ids.has("mac")).toBe(false);
  });

  it("keeps a reachable executor non-actionable while its catalog snapshot is stale", () => {
    const ids = resolveActionableCatalogExecutorIds(catalog, [{
      apiVersion: "4", appServerSchemaVersion: "0.160.0", baseUrl: "https://linux.example", createdAt: 1,
      displayName: "Build Linux", enabled: true, generation: 1, id: "linux", instanceId: "linux-instance",
      lastError: null, lastSeenAt: 1, status: "ready", updatedAt: 1,
    }], new Set(["linux"]));
    const model = buildFederatedSidebarModel(catalog, new Set(["linux"]), ids);

    expect(ids.has("linux")).toBe(false);
    expect(model.contextById[model.projects[0]!.id]).toMatchObject({ actionable: false, available: true, stale: true });
  });
});
