import type { Project, ThreadSummary } from "../api/client";
import type { FederatedCatalog, FederatedExecutor, QualifiedCatalogRef } from "../api/federatorClient";
import { buildFederatedCatalogProjection, catalogTargetKey, parseCatalogTargetKey } from "./catalogProjection";

export type FederatedSidebarItemContext = {
  actionable: boolean;
  available: boolean;
  executorName: string;
  observedAt: number;
  stale: boolean;
};

export type FederatedSidebarModel = {
  chatThreads: ThreadSummary[];
  contextById: Record<string, FederatedSidebarItemContext>;
  executors: ReturnType<typeof buildFederatedCatalogProjection>["executors"];
  pinnedThreads: ThreadSummary[];
  projects: Project[];
  resolveTarget: (key: string) => QualifiedCatalogRef | null;
  threadsByProjectId: Record<string, ThreadSummary[]>;
};

export function federatedExecutorContextLabel(context: FederatedSidebarItemContext): string {
  if (!context.available) return `${context.executorName} · Offline · Last seen ${formatObservedAt(context.observedAt)}`;
  if (context.stale) return `${context.executorName} · Stale · Last seen ${formatObservedAt(context.observedAt)}`;
  if (!context.actionable) return `${context.executorName} · Refreshing`;
  return context.executorName;
}

export function buildFederatedSidebarModel(
  catalog: FederatedCatalog,
  availableExecutorIds: ReadonlySet<string>,
  actionableExecutorIds: ReadonlySet<string> = availableExecutorIds,
  executorFilter: string | null = null,
): FederatedSidebarModel {
  const projection = buildFederatedCatalogProjection(catalog, executorFilter);
  const contextById: Record<string, FederatedSidebarItemContext> = {};

  const projects = projection.projects.map((entry) => {
    contextById[entry.key] = contextFor(entry, availableExecutorIds, actionableExecutorIds);
    return { ...entry.project, id: entry.key };
  });
  const pinnedThreads = projection.pinnedThreads.map((entry) => {
    contextById[entry.key] = contextFor(entry, availableExecutorIds, actionableExecutorIds);
    return qualifiedThread(entry.thread, entry.executorId);
  });
  const chatThreads = projection.chatThreads.map((entry) => {
    contextById[entry.key] = contextFor(entry, availableExecutorIds, actionableExecutorIds);
    return qualifiedThread(entry.thread, entry.executorId);
  });
  const threadsByProjectId = Object.fromEntries(
    projection.projects.map((project) => [
      project.key,
      (projection.projectThreadsByProjectKey[project.key] ?? []).map((entry) => {
        contextById[entry.key] = contextFor(entry, availableExecutorIds, actionableExecutorIds);
        return { ...qualifiedThread(entry.thread, entry.executorId), projectId: project.key };
      }),
    ]),
  );

  return {
    chatThreads,
    contextById,
    executors: projection.executors,
    pinnedThreads,
    projects,
    resolveTarget: parseCatalogTargetKey,
    threadsByProjectId,
  };
}

export function resolveActionableCatalogExecutorIds(
  catalog: FederatedCatalog,
  executors: readonly FederatedExecutor[],
  availableExecutorIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const registryGenerations = new Map(executors.map((entry) => [entry.id, entry.generation]));
  return new Set(
    catalog.executors
      .filter((entry) => !entry.stale
        && availableExecutorIds.has(entry.executorId)
        && registryGenerations.get(entry.executorId) === entry.generation)
      .map((entry) => entry.executorId),
  );
}

function qualifiedThread(thread: ThreadSummary, executorId: string): ThreadSummary {
  return {
    ...thread,
    id: catalogTargetKey({ executorId, nativeId: thread.id }),
    projectId: thread.projectId ? catalogTargetKey({ executorId, nativeId: thread.projectId }) : null,
  };
}

function contextFor(
  entry: { executorId: string; executorName: string; observedAt: number; stale: boolean },
  availableExecutorIds: ReadonlySet<string>,
  actionableExecutorIds: ReadonlySet<string>,
): FederatedSidebarItemContext {
  return {
    actionable: actionableExecutorIds.has(entry.executorId),
    available: availableExecutorIds.has(entry.executorId),
    executorName: entry.executorName,
    observedAt: entry.observedAt,
    stale: entry.stale,
  };
}

function formatObservedAt(value: number): string {
  if (value <= 0) return "unknown";
  return new Date(value * 1_000).toLocaleString();
}
