import { Alert, Button, Modal, Stack } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { createProject, type CreateProjectRequest, type Project } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { createClientRequestId } from "../shared/id";
import { errorMessageFrom } from "../shared/values";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { refreshProjectState } from "./cache";
import { DirectoryPicker } from "./DirectoryPicker";

export function WorkspaceProjectCreateDialog({ onClose, onCreated, onError }: {
  onClose: () => void;
  onCreated: (project: Project) => void;
  onError: (error: unknown) => void;
}) {
  const { openDraftThreadPane } = useWorkspace();
  return <ProjectCreateDialog onClose={onClose} onCreated={(project) => {
    onCreated(project);
    void openDraftThreadPane(project.id).catch(onError);
  }} />;
}

export function ProjectCreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const queryClient = useQueryClient();
  const [root, setRoot] = useState<string | null>(null);
  const attempt = useRef<{ body: string; idempotencyKey: string } | null>(null);
  const create = useMutation({
    mutationFn: createProject,
    onSuccess: (project) => {
      void refreshProjectState(queryClient);
      queryClient.setQueryData<Project[]>(queryKeys.projects, (current) =>
        [...(current ?? []).filter((candidate) => candidate.id !== project.id), project].sort((left, right) => left.position - right.position),
      );
      onCreated(project);
      onClose();
    },
  });

  function submit() {
    if (!root) return;
    const fields = { name: root.split("/").filter(Boolean).at(-1) ?? root, roots: [{ path: root }] };
    const body = JSON.stringify(fields);
    if (attempt.current?.body !== body) attempt.current = { body, idempotencyKey: createClientRequestId() };
    const request: CreateProjectRequest = { ...fields, idempotencyKey: attempt.current.idempotencyKey };
    create.mutate(request);
  }

  return (
    <Modal opened onClose={onClose} title="Add project" closeOnClickOutside={!create.isPending} closeOnEscape={!create.isPending} withCloseButton={!create.isPending}>
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Stack>
          <DirectoryPicker value={root} onChange={(value) => { setRoot(value); create.reset(); }} disabled={create.isPending} />
          {create.error ? <Alert color="red">{errorMessageFrom(create.error)}</Alert> : null}
          <Button type="submit" disabled={!root} loading={create.isPending}>Add project</Button>
        </Stack>
      </form>
    </Modal>
  );
}
