import { Tooltip } from "@mantine/core";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview";
import { useSynchronizedAnimation } from "../ui/useSynchronizedAnimation";
import type { WorkspacePane } from "./paneTypes";
import { useWorkspace } from "./WorkspaceProvider";
import { ThreadStatusIndicator } from "../threads/ThreadStatusIndicator";
import { useWorkspacePaneIndicatorState } from "./WorkspacePaneIndicator";

type DockviewPaneParams = { activePaneId: string | null; pane: WorkspacePane };

export function WorkspaceDefaultTab(props: IDockviewPanelHeaderProps<DockviewPaneParams>) {
  const { paneHeaderAdornmentsById, paneTabStatusById } = useWorkspace();
  const pane = props.params.pane;
  const indicatorState = useWorkspacePaneIndicatorState(pane);
  const animationRef = useSynchronizedAnimation<HTMLSpanElement>(indicatorState);
  const syncing = paneHeaderAdornmentsById[props.api.id];
  const headerAdornment = indicatorState === "running"
    ? <span ref={animationRef} className="kodex-workspace-tab-running" aria-label="Thread in progress" role="status" />
    : indicatorState ? <ThreadStatusIndicator state={indicatorState} />
    : syncing ? <span aria-label="Pane syncing" role="status" title="Pane syncing">{syncing}</span> : null;
  const terminalStatus = pane.kind === "terminal" ? paneTabStatusById[props.api.id] : undefined;
  const tabClassName = [
    "kodex-workspace-tab",
    pane.kind === "terminal" ? "kodex-workspace-terminal-tab" : null,
    terminalStatus ? `kodex-workspace-terminal-tab-${terminalStatus}` : null,
  ].filter(Boolean).join(" ");

  const tabRef = useRef<HTMLDivElement>(null);
  const [title, setTitle] = useState(props.api.title ?? "");
  const [titleClipped, setTitleClipped] = useState(false);
  useLayoutEffect(() => {
    setTitle(props.api.title ?? "");
    const subscription = props.api.onDidTitleChange((event) => setTitle(event.title ?? ""));
    return () => subscription.dispose();
  }, [props.api]);

  const measureTitle = useCallback(() => {
    const tab = tabRef.current;
    const content = tab?.querySelector<HTMLElement>(".dv-default-tab-content");
    if (!tab || !content) return;
    let visibleRight = content.getBoundingClientRect().right;
    // Native close controls and status adornments overlay the title's right edge.
    for (const overlay of tab.querySelectorAll<HTMLElement>(".dv-default-tab-action, .kodex-workspace-pane-title-adornment")) {
      const style = getComputedStyle(overlay);
      const bounds = overlay.getBoundingClientRect();
      if (style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0 && bounds.width > 0) {
        visibleRight = Math.min(visibleRight, bounds.left);
      }
    }
    const range = document.createRange();
    range.selectNodeContents(content);
    setTitleClipped((range.getBoundingClientRect?.().right ?? 0) > visibleRight + 0.5);
  }, []);

  useLayoutEffect(() => {
    const tab = tabRef.current;
    const content = tab?.querySelector<HTMLElement>(".dv-default-tab-content");
    if (!tab || !content) return;
    measureTitle();
    const observer = new ResizeObserver(measureTitle);
    observer.observe(tab);
    observer.observe(content);
    document.fonts?.addEventListener("loadingdone", measureTitle);
    return () => {
      observer.disconnect();
      document.fonts?.removeEventListener("loadingdone", measureTitle);
    };
  }, [title, indicatorState, syncing, measureTitle]);

  const inlineAdornment = headerAdornment && indicatorState !== "running";
  const unread = indicatorState === "unread";
  const tooltipLabel = titleClipped && title
    ? <>{title}{unread ? <><br />Unread completed agent turn</> : null}</>
    : "Unread completed agent turn";
  return (
    <Tooltip label={tooltipLabel} disabled={!titleClipped && !unread} multiline maw="min(480px, calc(100vw - 24px))">
      <div data-pane-id={props.api.id} ref={tabRef} onMouseEnter={measureTitle} onMouseLeave={measureTitle} className={tabClassName} data-inline-adornment={inlineAdornment ? "true" : undefined} data-unread={indicatorState === "unread" ? "true" : undefined}>
        <DockviewDefaultTab {...props} />
        {inlineAdornment ? <span className="kodex-workspace-pane-title-adornment">{headerAdornment}</span> : headerAdornment}
      </div>
    </Tooltip>
  );
}
