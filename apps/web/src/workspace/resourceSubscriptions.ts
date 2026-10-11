import type { WorkspacePane } from "./paneTypes";
import { paneTargetRecord } from "./paneTypes";

export function workspaceSubscribedThreadIds(panes: WorkspacePane[]): string[] {
  const threadIds = new Set<string>();
  for (const pane of panes) {
    const target = paneTargetRecord(pane);
    if (pane.kind === "thread" && target.mode === "existing" && typeof target.threadId === "string") {
      threadIds.add(target.threadId);
    }
    if (pane.kind === "appSurface" && typeof target.threadId === "string") {
      threadIds.add(target.threadId);
    }
  }
  return Array.from(threadIds);
}

export function workspaceSubscribedThreadIdsByExecutor(panes: WorkspacePane[]): Map<string, string[]> {
  const threadIdsByExecutor = new Map<string, Set<string>>();
  for (const pane of panes) {
    if (!threadIdsByExecutor.has(pane.target.executorId)) {
      threadIdsByExecutor.set(pane.target.executorId, new Set());
    }
    const target = paneTargetRecord(pane);
    const threadId = pane.kind === "thread" && target.mode === "existing" && typeof target.threadId === "string"
      ? target.threadId
      : pane.kind === "appSurface" && typeof target.threadId === "string"
        ? target.threadId
        : null;
    if (!threadId) continue;
    const threadIds = threadIdsByExecutor.get(pane.target.executorId)!;
    threadIds.add(threadId);
    threadIdsByExecutor.set(pane.target.executorId, threadIds);
  }
  return new Map(Array.from(threadIdsByExecutor, ([executorId, threadIds]) => [executorId, Array.from(threadIds)]));
}
