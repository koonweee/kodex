import { Alert, Button, Modal, Stack, Textarea, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { createProject, type CreateProjectRequest, type Project } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { createClientRequestId } from "../shared/id";
import { errorMessageFrom } from "../shared/values";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { refreshProjectState } from "./cache";
import { projectRootsFromText } from "./roots";

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
  const [name, setName] = useState("");
  const [roots, setRoots] = useState("");
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
    const fields = { name: name.trim(), roots: projectRootsFromText(roots) };
    if (!fields.name) return;
    const body = JSON.stringify(fields);
    if (attempt.current?.body !== body) attempt.current = { body, idempotencyKey: createClientRequestId() };
    const request: CreateProjectRequest = { ...fields, idempotencyKey: attempt.current.idempotencyKey };
    create.mutate(request);
  }

  return (
    <Modal opened onClose={onClose} title="Add project" closeOnClickOutside={!create.isPending} closeOnEscape={!create.isPending} withCloseButton={!create.isPending}>
      <form onSubmit={(event) => { event.preventDefault(); submit(); }}>
        <Stack>
          <TextInput label="Project name" value={name} onChange={(event) => setName(event.currentTarget.value)} required disabled={create.isPending} />
          <Textarea label="Root directories" description="One absolute path per line. Leave empty to choose a working directory when starting a chat." value={roots} onChange={(event) => setRoots(event.currentTarget.value)} minRows={3} disabled={create.isPending} />
          {create.error ? <Alert color="red">{errorMessageFrom(create.error)}</Alert> : null}
          <Button type="submit" disabled={!name.trim()} loading={create.isPending}>Add project</Button>
        </Stack>
      </form>
    </Modal>
  );
}
