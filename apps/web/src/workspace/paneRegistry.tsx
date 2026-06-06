import { MessageSquareText, Sparkles, TerminalSquare } from "lucide-react";
import type { ReactElement } from "react";

import { GeneratedUiWorkspacePane } from "../panes/generatedUi/GeneratedUiWorkspacePane";
import { TerminalPane } from "../panes/terminal/TerminalPane";
import { ThreadPane } from "../panes/thread/ThreadPane";
import type { WorkspacePane, WorkspacePaneComponentProps, WorkspacePaneType } from "./paneTypes";
import { paneTargetRecord } from "./paneTypes";

type PaneDefinition = {
  icon: typeof MessageSquareText;
  component: (props: WorkspacePaneComponentProps) => ReactElement;
  title: (pane: WorkspacePane) => string;
};

export const paneRegistry: Record<WorkspacePaneType, PaneDefinition> = {
  thread: {
    icon: MessageSquareText,
    component: ThreadPane,
    title: (pane) => pane.title ?? (paneTargetRecord(pane).mode === "draft" ? "Draft Thread" : "Thread"),
  },
  generatedUi: {
    icon: Sparkles,
    component: GeneratedUiWorkspacePane,
    title: (pane) => pane.title ?? "Generated UI",
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

function PlaceholderPane({ pane, eyebrow, detail }: { pane: WorkspacePane; eyebrow: string; detail: string }) {
  const Icon = paneRegistry[pane.kind].icon;
  return (
    <section className="kodex-workspace-placeholder-pane" data-pane-kind={pane.kind}>
      <div className="kodex-workspace-placeholder-icon" aria-hidden="true">
        <Icon size={18} strokeWidth={1.8} />
      </div>
      <div className="kodex-workspace-placeholder-copy">
        <span className="kodex-workspace-placeholder-eyebrow">{eyebrow}</span>
        <strong>{paneRegistry[pane.kind].title(pane)}</strong>
        <span>{detail}</span>
      </div>
    </section>
  );
}
