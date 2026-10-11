import { Alert, Button } from "@mantine/core";
import { useEffect, useState } from "react";

import { ExecutorRuntimeBoundary } from "../api/GatewayClientContext";
import type { ExecutorRuntime } from "../api/queryClient";
import { ProjectCreateDialog } from "../projects/ProjectCreateDialog";
import { useWorkspace } from "../workspace/WorkspaceProvider";
import { ExecutorPickerDialog, type ExecutorChoice } from "./ExecutorPickerDialog";

export function FederatedProjectCreateFlow({
  choices,
  onClose,
  onCreated,
  onError,
  onExecutorUsed,
  opened,
  preferredExecutorId,
  runtimes,
}: {
  choices: ExecutorChoice[];
  onClose: () => void;
  onCreated: () => Promise<void> | void;
  onError: (error: unknown) => void;
  onExecutorUsed: (executorId: string) => void;
  opened: boolean;
  preferredExecutorId: string | null;
  runtimes: ReadonlyMap<string, ExecutorRuntime>;
}) {
  const { openDraftThreadPane } = useWorkspace();
  const [executorId, setExecutorId] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) setExecutorId(null);
    else if (executorId === null && choices.length === 1) setExecutorId(choices[0]!.id);
  }, [choices, executorId, opened]);

  if (!opened) return null;
  const runtime = executorId ? runtimes.get(executorId) : null;
  const executorActionable = executorId ? choices.some((choice) => choice.id === executorId) : false;
  return (
    <>
      <ExecutorPickerDialog
        choices={choices}
        kind="project"
        onClose={onClose}
        onConfirm={(selectedExecutorId) => {
          onExecutorUsed(selectedExecutorId);
          setExecutorId(selectedExecutorId);
        }}
        opened={!executorId}
        preferredExecutorId={preferredExecutorId}
      />
      {executorId ? (
        runtime ? (
          <ExecutorRuntimeBoundary
            executorId={executorId}
            fallback={null}
            preserveChildrenWhenUnavailable
          >
            <ProjectCreateDialog
              api={runtime.api}
              blockedMessage={executorActionable
                ? null
                : "The selected executor is unavailable or its navigation snapshot is stale. Your project form is preserved until it reconnects and refreshes."}
              onClose={onClose}
              onCreated={(project) => {
                onExecutorUsed(executorId);
                void openDraftThreadPane(project.id, { executorId }).catch(onError);
                void onCreated();
              }}
            />
          </ExecutorRuntimeBoundary>
        ) : (
          <Alert color="yellow">
            The selected executor is no longer registered.
            <Button mt="xs" size="xs" variant="default" onClick={onClose}>Close</Button>
          </Alert>
        )
      ) : null}
    </>
  );
}
