import { Tooltip } from "@mantine/core";
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview";
import type { WorkspacePane } from "./paneTypes";
import { useWorkspace } from "./WorkspaceProvider";
import { ThreadStatusIndicator, threadIndicatorState } from "../threads/ThreadStatusIndicator";

type DockviewPaneParams = { activePaneId: string | null; pane: WorkspacePane };

export function WorkspaceDefaultTab(props: IDockviewPanelHeaderProps<DockviewPaneParams>) {
  const { paneHeaderAdornmentsById, paneTabStatusById, threadSummariesById, paneThreadContextsById } = useWorkspace();
  const pane = props.params.pane;
  const thread = pane.kind === "thread" && pane.target.mode === "existing"
    ? threadSummariesById[pane.target.threadId] : undefined;
  const paneContext = paneThreadContextsById[props.api.id];
  const indicatorState = thread ? threadIndicatorState(thread)
    : pane.kind === "thread" && pane.target.mode === "existing" && paneContext?.id === pane.target.threadId
      ? paneContext.indicatorState : null;
  const syncing = paneHeaderAdornmentsById[props.api.id];
  const headerAdornment = indicatorState === "running"
    ? <span className="kodex-workspace-tab-running" aria-label="Thread in progress" role="status">
        <svg aria-hidden="true" focusable="false"><rect x="1" y="1" pathLength="100" /></svg>
      </span>
    : indicatorState ? <ThreadStatusIndicator state={indicatorState} />
    : syncing ? <span aria-label="Pane syncing" role="status" title="Pane syncing">{syncing}</span> : null;
  const terminalStatus = pane.kind === "terminal" ? paneTabStatusById[props.api.id] : undefined;
  const tabClassName = [
    "kodex-workspace-tab",
    pane.kind === "terminal" ? "kodex-workspace-terminal-tab" : null,
    terminalStatus ? `kodex-workspace-terminal-tab-${terminalStatus}` : null,
  ].filter(Boolean).join(" ");

  const inlineAdornment = headerAdornment && indicatorState !== "running";
  return (
    <Tooltip label="Unread completed agent turn" disabled={indicatorState !== "unread"}>
      <div className={tabClassName} data-inline-adornment={inlineAdornment ? "true" : undefined} data-unread={indicatorState === "unread" ? "true" : undefined}>
        <DockviewDefaultTab {...props} />
        {inlineAdornment ? <span className="kodex-workspace-pane-title-adornment">{headerAdornment}</span> : headerAdornment}
      </div>
    </Tooltip>
  );
}
