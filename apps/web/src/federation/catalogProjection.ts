import type { Project, ThreadSummary } from "../api/client";
import type { CatalogExecutorSnapshot, FederatedCatalog, QualifiedCatalogRef } from "../api/federatorClient";

type CatalogThreadSummary = CatalogExecutorSnapshot["snapshot"]["chatThreads"]["threads"][number];

export type FederatedCatalogProject = CatalogEntry & {
  project: Project;
};

export type FederatedCatalogThread = CatalogEntry & {
  thread: ThreadSummary;
};

type CatalogEntry = {
  executorId: string;
  executorName: string;
  key: string;
  observedAt: number;
  stale: boolean;
};

export type FederatedCatalogProjection = {
  chatThreads: FederatedCatalogThread[];
  executors: Array<{
    executorId: string;
    executorName: string;
    included: boolean;
    observedAt: number;
    stale: boolean;
  }>;
  pinnedThreads: FederatedCatalogThread[];
  projects: FederatedCatalogProject[];
  projectThreadsByProjectKey: Record<string, FederatedCatalogThread[]>;
};

export function catalogTargetKey(target: QualifiedCatalogRef): string {
  return JSON.stringify([target.executorId, target.nativeId]);
}

export function parseCatalogTargetKey(value: string): QualifiedCatalogRef | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [executorId, nativeId] = parsed;
    return typeof executorId === "string" && typeof nativeId === "string" ? { executorId, nativeId } : null;
  } catch {
    return null;
  }
}

export function buildFederatedCatalogProjection(
  catalog: FederatedCatalog,
  executorFilter: string | null = null,
): FederatedCatalogProjection {
  const projects = new Map<string, FederatedCatalogProject>();
  const pinnedThreads = new Map<string, FederatedCatalogThread>();
  const chatThreads: FederatedCatalogThread[] = [];
  const projectThreadsByProjectKey: Record<string, FederatedCatalogThread[]> = {};

  for (const executor of catalog.executors) {
    if (executorFilter && executor.executorId !== executorFilter) continue;
    const common = {
      executorId: executor.executorId,
      executorName: executor.executorName,
      observedAt: executor.observedAt,
      stale: executor.stale,
    };
    for (const project of executor.snapshot.projects) {
      const key = catalogTargetKey({ executorId: executor.executorId, nativeId: project.id });
      projects.set(key, { ...common, key, project });
      const nativeProjectThreads = executor.snapshot.projectThreads[project.id]?.threads ?? [];
      projectThreadsByProjectKey[key] = nativeProjectThreads.map((thread) => threadEntry(common, thread));
    }
    for (const thread of executor.snapshot.pinnedThreads.threads) {
      const entry = threadEntry(common, thread);
      pinnedThreads.set(entry.key, entry);
    }
    for (const thread of executor.snapshot.chatThreads.threads) {
      chatThreads.push(threadEntry(common, thread));
    }
  }

  return {
    projects: orderedCatalogEntries(catalog.projectOrder, projects),
    pinnedThreads: orderedCatalogEntries(catalog.pinnedOrder, pinnedThreads),
    chatThreads,
    projectThreadsByProjectKey,
    executors: catalog.executors.map((executor) => ({
      executorId: executor.executorId,
      executorName: executor.executorName,
      included: !executorFilter || executor.executorId === executorFilter,
      observedAt: executor.observedAt,
      stale: executor.stale,
    })),
  };
}

function threadEntry(
  common: Omit<CatalogEntry, "key">,
  thread: CatalogThreadSummary,
): FederatedCatalogThread {
  return {
    ...common,
    key: catalogTargetKey({ executorId: common.executorId, nativeId: thread.id }),
    thread: { ...thread, rawPayload: {} },
  };
}

function orderedCatalogEntries<T extends CatalogEntry>(
  order: QualifiedCatalogRef[],
  entries: Map<string, T>,
): T[] {
  const result: T[] = [];
  const included = new Set<string>();
  for (const target of order) {
    const key = catalogTargetKey(target);
    const entry = entries.get(key);
    if (entry) {
      result.push(entry);
      included.add(key);
    }
  }
  for (const [key, entry] of entries) {
    if (!included.has(key)) result.push(entry);
  }
  return result;
}
