import { useCallback } from "react";
import type { CreateTerminalSession } from "../api/client";
import { createPaneId } from "./paneStore";
import { paneTargetRecord, type WorkspacePane } from "./paneTypes";
import type { WorkspacePaneOpenOptions, WorkspacePanePlacementIntent } from "./panePlacement";

export type WorkspaceTerminalOpenOptions = WorkspacePaneOpenOptions & Pick<CreateTerminalSession, "command" | "cwd" | "projectId">;
type AppendPane = (pane: WorkspacePane, intent: WorkspacePanePlacementIntent, options?: WorkspacePaneOpenOptions) => void;
type FocusOrAppend = (pane: WorkspacePane, intent: WorkspacePanePlacementIntent, options?: WorkspacePaneOpenOptions, find?: (panes: WorkspacePane[]) => WorkspacePane | null) => void;

export function useToolPaneActions(appendPane: AppendPane, focusPaneOrAppend: FocusOrAppend) {
  const openDesktopPane = useCallback(async () => {
    focusPaneOrAppend({ id: createPaneId("desktop"), kind: "desktop", target: {}, title: "Desktop" }, "desktop", {},
      (panes) => panes.find((pane) => pane.kind === "desktop") ?? null);
  }, [focusPaneOrAppend]);
  const openTerminalPane = useCallback(
    async (options: WorkspaceTerminalOpenOptions = {}) => {
      const pane: WorkspacePane = {
        id: createPaneId("terminal"),
        kind: "terminal",
        target: {
          command: options.command ?? null,
          cwd: options.cwd ?? null,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          reuseRunning: !options.command && !options.cwd && !options.projectId,
        },
        title: "Terminal",
      };
      focusPaneOrAppend(pane, "terminal", options, terminalPaneForRequest(options));
    },
    [focusPaneOrAppend],
  );

  const openNewTerminalPane = useCallback(
    async (options: WorkspaceTerminalOpenOptions = {}) => {
      appendPane(
        {
          id: createPaneId("terminal"),
          kind: "terminal",
          target: {
            command: options.command ?? null,
            cwd: options.cwd ?? null,
            ...(options.projectId ? { projectId: options.projectId } : {}),
          },
          title: "Terminal",
        },
        "terminal",
        { ...options, duplicate: true },
      );
    },
    [appendPane],
  );

  return { openDesktopPane, openTerminalPane, openNewTerminalPane };
}

function terminalPaneForRequest(options: WorkspaceTerminalOpenOptions): (panes: WorkspacePane[]) => WorkspacePane | null {
  const command = options.command ?? null;
  const cwd = options.cwd ?? null;
  const projectId = options.projectId ?? null;
  return (panes) => {
    const terminalPanes = [...panes].reverse().filter((pane) => pane.kind === "terminal");
    if (!command && !cwd && !projectId) {
      return terminalPanes[0] ?? null;
    }
    return terminalPanes.find((pane) => {
      const target = paneTargetRecord(pane);
      return (
        (projectId ? target.projectId === projectId : !target.projectId) &&
        (!command || target.command === command) &&
        (!cwd || target.cwd === cwd)
      );
    }) ?? null;
  };
}

