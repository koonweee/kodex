import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type HTMLAttributes, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import type { WorkspacePane } from "./paneTypes";
import { useWorkspace } from "./WorkspaceProvider";
import { ThreadStatusIndicator, threadIndicatorState } from "../threads/ThreadStatusIndicator";

type DockviewPaneParams = { activePaneId: string | null; pane: WorkspacePane };

type DockviewTabRuntimeProps = IDockviewPanelHeaderProps<DockviewPaneParams> & {
  closeActionOverride?: () => void;
  hideClose?: boolean;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLDivElement>) => void;
};

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
    headerAdornment ? "kodex-workspace-tab-with-adornment" : null,
  ].filter(Boolean).join(" ");

  if (!headerAdornment) {
    return <DockviewDefaultTab {...props} className={tabClassName} />;
  }

  return (
    <WorkspaceTabWithAdornment
      {...props}
      adornment={headerAdornment}
      running={indicatorState === "running"}
      className={tabClassName}
    />
  );
}

function WorkspaceTabWithAdornment({
  adornment,
  running,
  className,
  ...props
}: IDockviewPanelHeaderProps<DockviewPaneParams> & { adornment: ReactNode; running: boolean; className: string }) {
  const {
    api,
    closeActionOverride,
    containerApi: _containerApi,
    hideClose,
    onPointerDown,
    onPointerLeave,
    onPointerUp,
    params: _params,
    tabLocation: _tabLocation,
    ...rest
  } = props as DockviewTabRuntimeProps;
  const title = useDockviewPanelTitle(api);
  const isMiddleMouseButton = useRef(false);
  const restProps = rest as HTMLAttributes<HTMLDivElement>;
  const mergedClassName = [restProps.className, className, "dv-default-tab"].filter(Boolean).join(" ");

  const onClose = useCallback((event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>) => {
    event.preventDefault();
    if (closeActionOverride) {
      closeActionOverride();
      return;
    }
    api.close();
  }, [api, closeActionOverride]);

  const onClosePointerDown = useCallback((event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
  }, []);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    isMiddleMouseButton.current = event.button === 1;
    onPointerDown?.(event);
  }, [onPointerDown]);

  const handlePointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (isMiddleMouseButton.current && event.button === 1 && !hideClose) {
      isMiddleMouseButton.current = false;
      onClose(event);
    }
    onPointerUp?.(event);
  }, [hideClose, onClose, onPointerUp]);

  const handlePointerLeave = useCallback((event: PointerEvent<HTMLDivElement>) => {
    isMiddleMouseButton.current = false;
    onPointerLeave?.(event);
  }, [onPointerLeave]);

  return (
    <div
      {...restProps}
      className={mergedClassName}
      data-testid="dockview-dv-default-tab"
      onPointerDown={handlePointerDown}
      onPointerLeave={handlePointerLeave}
      onPointerUp={handlePointerUp}
    >
      {running ? adornment : null}
      <span className="dv-default-tab-content kodex-workspace-tab-content">
        <span className="kodex-workspace-tab-title">{title}</span>
        {!running ? <span
          className="kodex-workspace-pane-title-adornment"
        >
          {adornment}
        </span> : null}
      </span>
      {!hideClose ? (
        <div className="dv-default-tab-action" onClick={onClose} onPointerDown={onClosePointerDown}>
          <span aria-hidden="true" className="dv-react-part kodex-workspace-tab-close-icon">
            <X size={11} strokeWidth={2.2} />
          </span>
        </div>
      ) : null}
    </div>
  );
}

function useDockviewPanelTitle(api: IDockviewPanelHeaderProps<DockviewPaneParams>["api"]) {
  const [title, setTitle] = useState(api.title);
  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title);
    });
    if (title !== api.title) {
      setTitle(api.title);
    }
    return () => {
      disposable.dispose();
    };
  }, [api, title]);
  return title;
}

