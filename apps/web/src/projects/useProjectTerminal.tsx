import { Autocomplete, Button, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";

import type { Project } from "../api/client";
import { paneTargetRecord } from "../workspace/paneTypes";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { singleProjectRoot } from "./roots";

export function useProjectTerminal({ projects, selectedMainPane, selectedProjectId, onOpened }: {
  projects: Project[];
  selectedMainPane: string;
  selectedProjectId: string | null;
  onOpened: () => void;
}) {
  const { openTerminalPane, paneThreadContextsById, threadSummariesById, workspace } = useWorkspace();
  const [choice, setChoice] = useState<"directory" | "project-root" | null>(null);
  const [directory, setDirectory] = useState("");

  function open(cwd?: string, projectId?: string) {
    void openTerminalPane({ cwd, projectId }).catch((error: unknown) => console.error("Failed to open workspace terminal pane", error));
    onOpened();
  }

  function openTerminal() {
    const pane = workspace.panes.find((candidate) => candidate.id === workspace.activePaneId);
    const target = pane ? paneTargetRecord(pane) : {};
    if (selectedMainPane === "thread" && pane?.kind === "thread" && target.mode === "existing") {
      const cwd = paneThreadContextsById[pane.id]?.cwd ?? (typeof target.threadId === "string" ? threadSummariesById[target.threadId]?.cwd : null);
      if (cwd) return open(cwd);
      setDirectory("");
      setChoice("directory");
      return;
    }
    const projectId = selectedMainPane === "project" ? selectedProjectId
      : pane?.kind === "thread" && target.mode === "draft" && typeof target.projectId === "string" ? target.projectId : null;
    if (!projectId) return open();
    const project = projects.find((candidate) => candidate.id === projectId) ?? null;
    const cwd = singleProjectRoot(project);
    if (cwd) return open(cwd, projectId);
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
          open(cwd);
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
