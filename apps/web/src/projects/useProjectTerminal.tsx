import { Autocomplete, Button, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";

import type { Project } from "../api/client";
import type { QualifiedCatalogRef } from "../api/federatorClient";
import { paneTargetRecord } from "../workspace/paneTypes";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { singleProjectRoot } from "./roots";

export function useProjectTerminal({ projects, resolveSidebarTarget, selectedMainPane, selectedProjectId, onOpened }: {
  projects: Project[];
  resolveSidebarTarget?: (key: string) => QualifiedCatalogRef | null;
  selectedMainPane: string;
  selectedProjectId: string | null;
  onOpened: () => void;
}) {
  const { defaultExecutorId, openTerminalPane, paneThreadContextsById, threadSummariesById, workspace } = useWorkspace();
  const [choice, setChoice] = useState<"directory" | "project-root" | null>(null);
  const [directory, setDirectory] = useState("");
  const [directoryExecutorId, setDirectoryExecutorId] = useState(defaultExecutorId);

  function open(cwd?: string, projectId?: string, executorId = defaultExecutorId) {
    void openTerminalPane({ cwd, executorId, projectId }).catch((error: unknown) => console.error("Failed to open workspace terminal pane", error));
    onOpened();
  }

  function openTerminal() {
    const pane = workspace.panes.find((candidate) => candidate.id === workspace.activePaneId);
    const target = pane ? paneTargetRecord(pane) : {};
    const activeExecutorId = typeof target.executorId === "string" ? target.executorId : defaultExecutorId;
    if (selectedMainPane === "thread" && pane?.kind === "thread" && target.mode === "existing") {
      const thread = typeof target.threadId === "string"
        ? projectableRecordForTarget(threadSummariesById, activeExecutorId, target.threadId, resolveSidebarTarget)
        : null;
      const cwd = paneThreadContextsById[pane.id]?.cwd ?? thread?.cwd ?? null;
      if (cwd) return open(cwd, undefined, activeExecutorId);
      setDirectory("");
      setDirectoryExecutorId(activeExecutorId);
      setChoice("directory");
      return;
    }
    const selectedProjectTarget = selectedMainPane === "project" && selectedProjectId
      ? resolveSidebarTarget?.(selectedProjectId) ?? { executorId: defaultExecutorId, nativeId: selectedProjectId }
      : null;
    const projectTarget = selectedProjectTarget ?? (pane?.kind === "thread" && target.mode === "draft" && typeof target.projectId === "string"
      ? { executorId: activeExecutorId, nativeId: target.projectId }
      : null);
    if (!projectTarget) return open(undefined, undefined, activeExecutorId);
    const project = projectForTarget(projects, projectTarget, resolveSidebarTarget);
    const cwd = singleProjectRoot(project);
    if (cwd) return open(cwd, projectTarget.nativeId, projectTarget.executorId);
    setChoice("project-root");
  }

  const terminalDirectoryDialog = (
    <Modal opened={choice !== null} onClose={() => setChoice(null)} title={choice === "project-root" ? "Project root required" : "Terminal working directory"}>
      {choice === "project-root" ? (
        <Text>Edit this project to choose one root directory before opening a terminal.</Text>
      ) : (
        <form onSubmit={(event) => {
          event.preventDefault();
          const cwd = directory.trim();
          if (!cwd) return;
          setChoice(null);
          open(cwd, undefined, directoryExecutorId);
        }}>
          <Stack>
            <Autocomplete label="Working directory" value={directory} onChange={setDirectory} required />
            <Button type="submit" disabled={!directory.trim()}>Open terminal</Button>
          </Stack>
        </form>
      )}
    </Modal>
  );
  return { openTerminal, terminalDirectoryDialog };
}

function projectForTarget(
  projects: Project[],
  target: QualifiedCatalogRef,
  resolveSidebarTarget?: (key: string) => QualifiedCatalogRef | null,
): Project | null {
  return projects.find((project) => {
    const resolved = resolveSidebarTarget?.(project.id) ?? { executorId: target.executorId, nativeId: project.id };
    return resolved.executorId === target.executorId && resolved.nativeId === target.nativeId;
  }) ?? null;
}

function projectableRecordForTarget<T>(
  records: Record<string, T>,
  executorId: string,
  nativeId: string,
  resolveSidebarTarget?: (key: string) => QualifiedCatalogRef | null,
): T | null {
  for (const [key, value] of Object.entries(records)) {
    const target = resolveSidebarTarget?.(key) ?? { executorId, nativeId: key };
    if (target.executorId === executorId && target.nativeId === nativeId) return value;
  }
  return null;
}
