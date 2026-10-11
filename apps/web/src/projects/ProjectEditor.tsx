import { Alert, Button, Modal, Stack, Text, Textarea, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import type { Project, UpdateProjectRequest } from "../api/client";
import { useGatewayClient } from "../api/GatewayClientContext";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { useExecutorConnection } from "../api/GatewayClientContext";
import { errorMessageFrom } from "../shared/values";
import { refreshProjectState } from "./cache";
import { projectRootsFromText } from "./roots";

export function ProjectEditor({ disabled = false, project, onChanged, onDeleted }: {
  disabled?: boolean;
  project: Project;
  onChanged?: () => void;
  onDeleted: () => void;
}) {
  const api = useGatewayClient();
  const queryClient = useQueryClient();
  const { publishThreadPaneTimelineAction } = useWorkspace();
  const executorId = useExecutorConnection()?.executorId ?? "local";
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [rootsEdit, setRootsEdit] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const save = useMutation({
    mutationFn: (request: UpdateProjectRequest) => disabled
      ? Promise.reject(new Error("Project editing is unavailable until the executor catalog is fresh."))
      : api.updateProject(project.id, request),
    onSuccess: async () => { await refreshProjectState(queryClient); setNameEdit(null); setRootsEdit(null); onChanged?.(); },
  });
  const remove = useMutation({
    mutationFn: () => disabled
      ? Promise.reject(new Error("Project editing is unavailable until the executor catalog is fresh."))
      : api.deleteProject(project.id),
    onSuccess: async () => {
      publishThreadPaneTimelineAction({ executorId, kind: "refresh_snapshot" });
      await refreshProjectState(queryClient);
      onChanged?.();
      onDeleted();
    },
  });
  const name = nameEdit ?? project.name;
  const roots = rootsEdit ?? project.roots.map((root) => root.path).join("\n");
  const changes: UpdateProjectRequest = {
    ...(nameEdit !== null && name.trim() !== project.name ? { name: name.trim() } : {}),
    ...(rootsEdit !== null && JSON.stringify(projectRootsFromText(roots)) !== JSON.stringify(project.roots) ? { roots: projectRootsFromText(roots) } : {}),
  };
  const pending = save.isPending || remove.isPending;
  const error = save.error ?? remove.error;
  useEffect(() => {
    if (disabled) setDeleteOpen(false);
  }, [disabled]);

  return (
    <Stack>
      <form onSubmit={(event) => { event.preventDefault(); if (!disabled) save.mutate(changes); }}>
        <Stack>
          <TextInput label="Project name" value={name} onChange={(event) => setNameEdit(event.currentTarget.value)} required disabled={disabled || pending} />
          <Textarea label="Root directories" description="One absolute path per line. Existing chats keep their working directory." value={roots} onChange={(event) => setRootsEdit(event.currentTarget.value)} minRows={3} disabled={disabled || pending} />
          <Button type="submit" loading={save.isPending} disabled={disabled || pending || !name.trim() || Object.keys(changes).length === 0}>Save project</Button>
        </Stack>
      </form>
      {error ? <Alert color="red">{errorMessageFrom(error)}</Alert> : null}
      <Button color="red" variant="subtle" onClick={() => setDeleteOpen(true)} disabled={disabled || pending}>Delete project</Button>
      <Modal opened={deleteOpen} onClose={() => setDeleteOpen(false)} title={`Delete ${project.name}?`}>
        <Stack>
          <Text>Its chats will remain available without a project. Files are unchanged.</Text>
          <Button color="red" disabled={disabled} loading={remove.isPending} onClick={() => { if (!disabled) remove.mutate(); }}>Delete project</Button>
        </Stack>
      </Modal>
    </Stack>
  );
}
