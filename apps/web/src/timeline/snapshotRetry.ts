export const MATERIALIZING_THREAD_SNAPSHOT_RETRY_MS = 250;

export function isTransientThreadSnapshotLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("not materialized yet") ||
    normalized.includes("failed to load rollout") ||
    normalized.includes("failed to load thread history") ||
    (normalized.includes("rollout at") && normalized.includes(" is empty"))
  );
}
