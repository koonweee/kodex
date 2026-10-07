import type { IDockviewHeaderActionsProps } from "dockview";
import { useWorkspace } from "./WorkspaceProvider";

export function WorkspaceRightHeaderActions({ activePanel, panels }: IDockviewHeaderActionsProps) {
  const { paneHeaderActionsById } = useWorkspace();
  return (
    <div aria-label="Pane actions" className="kodex-workspace-pane-actions kodex-workspace-group-actions" role="toolbar">
      {panels.map(panel => (
        <div key={`${panel.id}:${panel.id === activePanel?.id}`} className="kodex-workspace-group-action-slot"
          data-active={panel.id === activePanel?.id || undefined}
          aria-hidden={panel.id !== activePanel?.id}
          inert={panel.id !== activePanel?.id}>
          {paneHeaderActionsById[panel.id]}
        </div>
      ))}
    </div>
  );
}

