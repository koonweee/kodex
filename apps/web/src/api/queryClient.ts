import { QueryClient } from "@tanstack/react-query";

import { createExecutorGatewayClient, type FederatedExecutor, type FederatedExecutorListResponse } from "./client";
import { snapshotConnection } from "./executorConnection";
import { createExecutorStorage, type InstanceStorage } from "./instanceStorage";

export function createKodexQueryClient() {
  return new QueryClient({
    defaultOptions: {
      mutations: {
        retry: 0,
      },
      queries: {
        gcTime: 5 * 60 * 1000,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: 1,
        staleTime: 30 * 1000,
      },
    },
  });
}

export const queryClient = createKodexQueryClient();

export function createExecutorRuntime(
  executor: FederatedExecutor,
  {
    baseUrl,
    storage,
  }: { baseUrl?: string; storage?: InstanceStorage | null } = {},
) {
  const record = Object.freeze({ ...executor });
  const connection = snapshotConnection({
    executorId: record.id,
    instanceId: record.instanceId,
  });
  return Object.freeze({
    api: createExecutorGatewayClient(connection, { baseUrl }),
    connection,
    queryClient: createKodexQueryClient(),
    storage: createExecutorStorage(connection.executorId, connection.instanceId, storage),
  });
}

export type ExecutorRuntime = ReturnType<typeof createExecutorRuntime>;

export type ExecutorRuntimeEntry = {
  executor: Readonly<FederatedExecutor>;
  runtime: ExecutorRuntime;
};

export class ExecutorRuntimeRegistry {
  private appliedRevision: number | null = null;
  private readonly entries = new Map<string, ExecutorRuntimeEntry>();
  private order: string[] = [];
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly options: { baseUrl?: string; storage?: InstanceStorage | null } = {},
  ) {}

  get(executorId: string): ExecutorRuntimeEntry | undefined {
    return this.entries.get(executorId);
  }

  synchronize(snapshot: FederatedExecutorListResponse): Promise<ExecutorRuntimeEntry[]> {
    const captured: FederatedExecutorListResponse = {
      revision: snapshot.revision,
      executors: snapshot.executors.map((executor) => Object.freeze({ ...executor })),
    };
    const result = this.pending.then(() => this.apply(captured));
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async apply(snapshot: FederatedExecutorListResponse): Promise<ExecutorRuntimeEntry[]> {
    if (this.appliedRevision !== null && snapshot.revision <= this.appliedRevision) {
      return this.currentEntries();
    }
    const executors = snapshot.executors;
    const nextIds = new Set(executors.map((executor) => executor.id));
    for (const [executorId, entry] of this.entries) {
      if (!nextIds.has(executorId)) {
        await disposeExecutorRuntime(entry.runtime);
        this.entries.delete(executorId);
      }
    }

    const ordered = [] as ExecutorRuntimeEntry[];
    for (const executor of executors) {
      const record = Object.freeze({ ...executor });
      const current = this.entries.get(record.id);
      let runtime = current?.runtime;
      if (runtime && runtime.connection.instanceId !== record.instanceId) {
        await disposeExecutorRuntime(runtime);
        runtime = undefined;
      }
      runtime ??= createExecutorRuntime(record, this.options);
      const entry = Object.freeze({ executor: record, runtime });
      this.entries.set(record.id, entry);
      ordered.push(entry);
    }
    this.order = ordered.map((entry) => entry.executor.id);
    this.appliedRevision = snapshot.revision;
    return ordered;
  }

  private currentEntries(): ExecutorRuntimeEntry[] {
    return this.order.flatMap((executorId) => {
      const entry = this.entries.get(executorId);
      return entry ? [entry] : [];
    });
  }
}

async function disposeExecutorRuntime(runtime: ExecutorRuntime) {
  await runtime.queryClient.cancelQueries();
  runtime.queryClient.clear();
}
