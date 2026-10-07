import { useCallback, useEffect, useState } from "react";

import type { ThreadSummary } from "../api/client";
import type { threadIndicatorState } from "../threads/ThreadStatusIndicator";
import type { WorkspacePane } from "./paneTypes";

export type PaneThreadContext = Pick<ThreadSummary, "id" | "projectId" | "cwd"> & { indicatorState?: ReturnType<typeof threadIndicatorState> };

// Context already loaded by mounted panes, retained only while their pane exists.
// It feeds pane actions; it never feeds the canonical snapshot owner back as a seed.
export function usePaneThreadContexts(panes: WorkspacePane[]) {
  const [paneThreadContextsById, setPaneThreadContextsById] = useState<Record<string, PaneThreadContext>>({});
  const setPaneThreadContext = useCallback((paneId: string, context: PaneThreadContext | null) => {
    setPaneThreadContextsById((current) => {
      const previous = current[paneId];
      if (context ? previous?.id === context.id && previous.projectId === context.projectId && previous.cwd === context.cwd && previous.indicatorState === context.indicatorState : !previous) return current;
      const next = { ...current };
      if (context) next[paneId] = context;
      else delete next[paneId];
      return next;
    });
  }, []);

  useEffect(() => {
    setPaneThreadContextsById((current) => {
      const retained = Object.entries(current).filter(([paneId, context]) => panes.some((pane) => pane.id === paneId && pane.kind === "thread" && pane.target.mode === "existing" && pane.target.threadId === context.id));
      return retained.length === Object.keys(current).length ? current : Object.fromEntries(retained);
    });
  }, [panes]);

  return { paneThreadContextsById, setPaneThreadContext };
}
