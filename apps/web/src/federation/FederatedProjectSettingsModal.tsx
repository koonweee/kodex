import { Alert, Modal } from "@mantine/core";

import type { Project } from "../api/client";
import { ExecutorRuntimeBoundary } from "../api/GatewayClientContext";
import { ProjectEditor } from "../projects/ProjectEditor";

export function FederatedProjectSettingsModal({
  actionable,
  executorId,
  onClose,
  onRefresh,
  project,
}: {
  actionable: boolean;
  executorId: string;
  onClose: () => void;
  onRefresh: () => void;
  project: Project;
}) {
  return (
    <Modal centered onClose={onClose} opened size="lg" title={`${project.name} · Project settings`}>
      {!actionable ? (
        <Alert color="yellow" mb="md" title="Project editing paused">
          Reconnect or refresh this executor before saving or deleting. Your edits are preserved.
        </Alert>
      ) : null}
      <ExecutorRuntimeBoundary
        executorId={executorId}
        fallback={null}
        preserveChildrenWhenUnavailable
      >
        <ProjectEditor disabled={!actionable} project={project} onChanged={onRefresh} onDeleted={() => { onRefresh(); onClose(); }} />
      </ExecutorRuntimeBoundary>
    </Modal>
  );
}
