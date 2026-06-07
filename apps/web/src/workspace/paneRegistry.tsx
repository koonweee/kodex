import { MessageSquareText, Sparkles, TerminalSquare } from "lucide-react";
import type { ReactElement } from "react";

import { AppSurfaceWorkspacePane } from "../panes/appSurface/AppSurfaceWorkspacePane";
import { TerminalPane } from "../panes/terminal/TerminalPane";
import { ThreadPane } from "../panes/thread/ThreadPane";
import type { WorkspacePane, WorkspacePaneComponentProps, WorkspacePaneType } from "./paneTypes";
import { paneTargetRecord } from "./paneTypes";

type PaneDefinition = {
  icon: typeof MessageSquareText;
  component: (props: WorkspacePaneComponentProps) => ReactElement;
  title: (pane: WorkspacePane) => string;
};

const paneRegistry: Record<WorkspacePaneType, PaneDefinition> = {
  thread: {
    icon: MessageSquareText,
    component: ThreadPane,
    title: (pane) => pane.title ?? (paneTargetRecord(pane).mode === "draft" ? "Draft Thread" : "Thread"),
  },
  appSurface: {
    icon: Sparkles,
    component: AppSurfaceWorkspacePane,
    title: (pane) => pane.title ?? "App Surface",
  },
  terminal: {
    icon: TerminalSquare,
    component: TerminalPane,
    title: (pane) => pane.title ?? "Terminal",
  },
};

export function WorkspacePaneRenderer({ pane, isActive }: WorkspacePaneComponentProps) {
  const definition = paneRegistry[pane.kind];
  const Component = definition.component;
  return <Component pane={pane} isActive={isActive} />;
}
