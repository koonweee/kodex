import type { IDockviewPanel } from "dockview";

export function focusWorkspaceDockPanel(panel: IDockviewPanel | undefined): void {
  if (!panel) return;
  if (panel.api.isVisible && panel.group.activePanel === panel) {
    // Reopening visible content detaches its DOM and can reset timeline scroll.
    panel.group.api.setActive();
  } else {
    panel.focus();
  }
}
