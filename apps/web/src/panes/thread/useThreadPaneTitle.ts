import { useEffect } from "react";
import type { WorkspacePanePatch } from "../../workspace/paneTypes";

export function useThreadPaneTitle(
  paneId: string,
  paneTitle: string | null | undefined,
  title: string | null,
  updatePane: (paneId: string, request: WorkspacePanePatch) => Promise<void>,
) {
  useEffect(() => {
    if (!title || title === paneTitle) return;
    void updatePane(paneId, { title }).catch((error: unknown) => {
      console.error("Failed to update workspace thread pane title", error);
    });
  }, [paneId, paneTitle, title, updatePane]);
}
