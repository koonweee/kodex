import { Autocomplete, Button, Modal, Stack } from "@mantine/core";
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
  const { openTerminalPane, paneThreadContextsById, threadSummariesById, updatePane, workspace } = useWorkspace();
  const [choice, setChoice] = useState<{ project: Project | null; draftPaneId: string | null } | null>(null);
  const [directory, setDirectory] = useState("");

  function open(cwd?: string) {
    void openTerminalPane({ cwd }).catch((error: unknown) => console.error("Failed to open workspace terminal pane", error));
    onOpened();
  }

  function openTerminal() {
    const pane = workspace.panes.find((candidate) => candidate.id === workspace.activePaneId);
    const target = pane ? paneTargetRecord(pane) : {};
    if (selectedMainPane === "thread" && pane?.kind === "thread" && target.mode === "existing") {
      const cwd = paneThreadContextsById[pane.id]?.cwd ?? (typeof target.threadId === "string" ? threadSummariesById[target.threadId]?.cwd : null);
      if (cwd) return open(cwd);
      setChoice({ project: null, draftPaneId: null });
      return;
    }
    const projectId = selectedMainPane === "project" ? selectedProjectId
      : pane?.kind === "thread" && target.mode === "draft" && typeof target.projectId === "string" ? target.projectId : null;
    if (!projectId) return open();
    const project = projects.find((candidate) => candidate.id === projectId) ?? null;
    const draftPaneId = selectedMainPane === "thread" && pane?.kind === "thread" && target.mode === "draft" ? pane.id : null;
    const cwd = draftPaneId && typeof target.cwd === "string" ? target.cwd.trim() : singleProjectRoot(project);
    if (cwd) return open(cwd);
    setDirectory("");
    setChoice({ project, draftPaneId });
  }

  const terminalDirectoryDialog = (
    <Modal opened={choice !== null} onClose={() => setChoice(null)} title="Terminal working directory">
      <form onSubmit={(event) => {
        event.preventDefault();
        const cwd = directory.trim();
        if (!cwd) return;
        if (choice?.draftPaneId) {
          void updatePane(choice.draftPaneId, { target: { mode: "draft", projectId: choice.project?.id, cwd } });
        }
        setChoice(null);
        open(cwd);
      }}>
        <Stack>
          <Autocomplete label="Working directory" description="Choose where the terminal starts. It can be outside the project roots." data={choice?.project?.roots.map((root) => root.path) ?? []} value={directory} onChange={setDirectory} required />
          <Button type="submit" disabled={!directory.trim()}>Open terminal</Button>
        </Stack>
      </form>
    </Modal>
  );
  return { openTerminal, terminalDirectoryDialog };
}
