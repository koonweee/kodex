import { ThreadStatusIndicator, threadIndicatorState } from "../threads/ThreadStatusIndicator";
import type { WorkspacePane } from "./paneTypes";
import { useWorkspace } from "./WorkspaceProvider";

export function useWorkspacePaneIndicatorState(pane: WorkspacePane) {
  const { threadSummariesById, paneThreadContextsById } = useWorkspace();
  if (pane.kind !== "thread" || pane.target.mode !== "existing") return null;
  const thread = threadSummariesById[pane.target.threadId];
  if (thread) return threadIndicatorState(thread);
  const context = paneThreadContextsById[pane.id];
  return context?.id === pane.target.threadId ? context.indicatorState ?? null : null;
}

export function WorkspacePaneIndicator({ pane }: { pane: WorkspacePane }) {
  const state = useWorkspacePaneIndicatorState(pane);
  const { paneHeaderAdornmentsById } = useWorkspace();
  if (state) return <ThreadStatusIndicator className="kodex-workspace-pane-title-adornment" state={state} />;
  const syncing = paneHeaderAdornmentsById[pane.id];
  return syncing ? (
    <span aria-label="Pane syncing" className="kodex-workspace-pane-title-adornment" role="status" title="Pane syncing">
      {syncing}
    </span>
  ) : null;
}
