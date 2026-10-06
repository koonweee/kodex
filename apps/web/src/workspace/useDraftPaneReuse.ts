import { useCallback, useEffect, useRef } from "react";
import type { WorkspacePane } from "./paneTypes";

// Draft occupancy is per-tab presentation state. Keep the latest report when a
// renderer unmounts, and treat an unreported draft conservatively.
export function useDraftPaneReuse(panes: WorkspacePane[]) {
  const disposableByPaneId = useRef(new Map<string, boolean>());
  const setPaneDraftDisposable = useCallback((paneId: string, disposable: boolean) => {
    disposableByPaneId.current.set(paneId, disposable);
  }, []);
  const isReusableDraft = useCallback((pane: WorkspacePane) =>
    pane.kind === "thread" && pane.target.mode === "draft" && disposableByPaneId.current.get(pane.id) === true,
  []);
  useEffect(() => {
    const paneIds = new Set(panes.map((pane) => pane.id));
    for (const paneId of disposableByPaneId.current.keys()) {
      if (!paneIds.has(paneId)) disposableByPaneId.current.delete(paneId);
    }
  }, [panes]);
  return { isReusableDraft, setPaneDraftDisposable };
}
