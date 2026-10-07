import { useEffect } from 'react';
import { useWorkspace } from '../workspace/WorkspaceProvider';

/** Catalog archive state applies to every saved pane, including unmounted panes
 * in narrow/hidden workspaces. Ordinary absence from inventory does not close it. */
export function NativeArchiveReconciliation({ archivedChatIds }: { archivedChatIds: string[] }) {
  const { workspace, closeThreadPanes } = useWorkspace();
  useEffect(() => {
    for (const id of archivedChatIds) {
      if (workspace.panes.some(pane => pane.kind === 'thread' && pane.target.mode === 'existing' && pane.target.threadId === id)) closeThreadPanes(id);
    }
  }, [archivedChatIds, workspace.panes, closeThreadPanes]);
  return null;
}
