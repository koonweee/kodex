import type { ComponentProps } from 'react';
import { KodexShellView } from '../shell/KodexShellView';
import { useWorkspace } from '../workspace/WorkspaceProvider';

// Native descendants can be opened without belonging to the sidebar inventory.
// Reuse metadata already read by the active pane; do not expand the catalog.
export function NativeWorkspaceShellView(props: ComponentProps<typeof KodexShellView>) {
  const { workspace, paneThreadContextsById } = useWorkspace();
  const activePane = workspace.panes.find(pane => pane.id === workspace.activePaneId);
  const context = activePane && props.mainPane === 'thread' && activePane.kind === 'thread'
    && activePane.target.mode === 'existing' && activePane.target.threadId === props.workspaceSidebarProps.selectedThreadId
    ? paneThreadContextsById[activePane.id] : undefined;
  const selectedProjectId = context?.id === props.workspaceSidebarProps.selectedThreadId
    ? context.projectId ?? null : props.workspaceSidebarProps.selectedProjectId;
  return <KodexShellView {...props} workspaceSidebarProps={{ ...props.workspaceSidebarProps, selectedProjectId }} />;
}
