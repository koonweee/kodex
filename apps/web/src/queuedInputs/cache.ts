import type { QueryClient } from "@tanstack/react-query";

import type { QueuedInput } from "../api/client";
import { queryKeys } from "../api/queryKeys";

export function mergeQueuedInputData(
  current: QueuedInput[] | undefined,
  snapshot: QueuedInput[],
  deletedIds: string[] = [],
): QueuedInput[] {
  const deleted = new Set(deletedIds);
  const byId = new Map<string, QueuedInput>();
  for (const row of snapshot) {
    if (!deleted.has(row.id)) {
      byId.set(row.id, row);
    }
  }
  for (const row of current ?? []) {
    if (deleted.has(row.id)) {
      continue;
    }
    const loaded = byId.get(row.id);
    byId.set(row.id, newerQueuedInput(row, loaded));
  }
  return sortQueuedInputs([...byId.values()]);
}

export function upsertCachedQueuedInput(queryClient: QueryClient, row: QueuedInput) {
  queryClient.setQueryData<string[]>(queryKeys.queuedInputTombstones(row.threadId), (current) =>
    (current ?? []).filter((id) => id !== row.id),
  );
  queryClient.setQueryData<QueuedInput[]>(queryKeys.queuedInputs(row.threadId), (current) =>
    sortQueuedInputs([...(current ?? []).filter((item) => item.id !== row.id), row]),
  );
}

export function deleteCachedQueuedInput(queryClient: QueryClient, threadId: string, id: string) {
  queryClient.setQueryData<string[]>(queryKeys.queuedInputTombstones(threadId), (current) =>
    current?.includes(id) ? current : [...(current ?? []), id],
  );
  queryClient.setQueryData<QueuedInput[]>(queryKeys.queuedInputs(threadId), (current) =>
    current ? current.filter((item) => item.id !== id) : current,
  );
}

export function sortQueuedInputs(rows: QueuedInput[]): QueuedInput[] {
  return [...rows].sort(compareQueuedInputs);
}

function newerQueuedInput(left: QueuedInput, right: QueuedInput | undefined): QueuedInput {
  if (!right) {
    return left;
  }
  return new Date(left.updatedAt).getTime() >= new Date(right.updatedAt).getTime() ? left : right;
}

function compareQueuedInputs(left: QueuedInput, right: QueuedInput): number {
  const priority = (row: QueuedInput) => (row.priority === "rejectedSteer" ? 0 : 1);
  const priorityDelta = priority(left) - priority(right);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
}
