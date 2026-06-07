export type WorkspacePaneType = "thread" | "appSurface" | "terminal";

export type ThreadPaneTarget =
  | { mode: "existing"; threadId: string }
  | { mode: "draft"; projectId?: string | null };

export type AppSurfacePaneTarget =
  | { mode: "latest"; threadId: string }
  | { mode: "session"; threadId: string; sessionId: string };

export type TerminalPaneTarget = {
  command?: string | null;
  cwd?: string | null;
  terminalId?: string | null;
};

export type WorkspacePane =
  | {
      id: string;
      kind: "thread";
      target: ThreadPaneTarget;
      title?: string | null;
    }
  | {
      id: string;
      kind: "appSurface";
      target: AppSurfacePaneTarget;
      title?: string | null;
    }
  | {
      id: string;
      kind: "terminal";
      target: TerminalPaneTarget;
      title?: string | null;
    };

export type WorkspacePaneState = {
  activePaneId: string | null;
  dockviewLayout: unknown | null;
  panes: WorkspacePane[];
  schemaVersion: number;
};

export type WorkspaceModel = WorkspacePaneState;

export type WorkspacePanePatch = {
  target?: WorkspacePane["target"];
  title?: string | null;
};

export type PaneTargetRecord = Record<string, unknown>;

export type WorkspacePaneComponentProps = {
  pane: WorkspacePane;
  isActive: boolean;
};

export function paneTargetRecord(pane: WorkspacePane): PaneTargetRecord {
  return typeof pane.target === "object" && pane.target !== null && !Array.isArray(pane.target)
    ? (pane.target as PaneTargetRecord)
    : {};
}

export function paneTitle(pane: WorkspacePane): string {
  if (pane.title) {
    return pane.title;
  }
  if (pane.kind === "thread") {
    return pane.target.mode === "draft" ? "Draft Thread" : "Thread";
  }
  if (pane.kind === "appSurface") {
    return "App Surface";
  }
  return "Terminal";
}
