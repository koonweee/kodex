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
