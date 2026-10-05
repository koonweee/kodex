import { Menu } from "@mantine/core";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { assignThreadProject, type Project } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { refreshProjectState } from "./cache";

export function ThreadProjectMenuItems({ threadId, projectId, onError }: {
  threadId: string;
  projectId: string | null;
  onError: (error: unknown) => void;
}) {
  const queryClient = useQueryClient();
  const { data: projects = [] } = useQuery<Project[]>({ queryKey: queryKeys.projects, queryFn: skipToken });
  const { publishThreadPaneTimelineAction } = useWorkspace();
  const assign = useMutation({
    mutationFn: (nextProjectId: string | null) => assignThreadProject(threadId, nextProjectId),
    onError,
    onSuccess: () => {
      publishThreadPaneTimelineAction({ kind: "refresh_snapshot", threadId });
      return refreshProjectState(queryClient);
    },
  });
  return (
    <>
      <Menu.Label>Move chat to project</Menu.Label>
      <Menu.Item disabled={assign.isPending || projectId === null} onClick={() => assign.mutate(null)}>No project</Menu.Item>
      {projects.map((candidate) => <Menu.Item key={candidate.id} disabled={assign.isPending || candidate.id === projectId} onClick={() => assign.mutate(candidate.id)}>{candidate.name}</Menu.Item>)}
    </>
  );
}
