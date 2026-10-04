import { Button, Menu } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { assignThreadProject, type Project } from "../api/client";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { refreshProjectState } from "./cache";

export function ThreadProjectSelect({ threadId, projectId, projects, onError }: {
  threadId: string;
  projectId: string | null;
  projects: Project[];
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const { publishThreadPaneTimelineAction } = useWorkspace();
  const assign = useMutation({
    mutationFn: (nextProjectId: string | null) => assignThreadProject(threadId, nextProjectId),
    onError,
    onSuccess: () => {
      publishThreadPaneTimelineAction({ kind: "refresh_snapshot", threadId });
      return refreshProjectState(queryClient);
    },
  });
  const project = projects.find((candidate) => candidate.id === projectId);
  return (
    <Menu>
      <Menu.Target><Button size="xs" variant="subtle" loading={assign.isPending} aria-label={`Chat project: ${project?.name ?? "No project"}`}>{project?.name ?? "No project"}</Button></Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Move chat to project</Menu.Label>
        <Menu.Item disabled={projectId === null} onClick={() => assign.mutate(null)}>No project</Menu.Item>
        {projects.map((candidate) => <Menu.Item key={candidate.id} disabled={candidate.id === projectId} onClick={() => assign.mutate(candidate.id)}>{candidate.name}</Menu.Item>)}
      </Menu.Dropdown>
    </Menu>
  );
}
