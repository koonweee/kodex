import { Button, Group, Modal, Select, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";

export type ExecutorChoice = {
  id: string;
  name: string;
};

export function ExecutorPickerDialog({
  choices,
  kind,
  onClose,
  onConfirm,
  opened,
  preferredExecutorId,
}: {
  choices: ExecutorChoice[];
  kind: "automation" | "chat" | "project";
  onClose: () => void;
  onConfirm: (executorId: string) => void;
  opened: boolean;
  preferredExecutorId: string | null;
}) {
  const fallback = choices.some((choice) => choice.id === preferredExecutorId)
    ? preferredExecutorId
    : choices[0]?.id ?? null;
  const [executorId, setExecutorId] = useState<string | null>(fallback);

  useEffect(() => {
    if (opened) setExecutorId(fallback);
  }, [fallback, opened]);

  const noun = kind === "project" ? "project" : kind === "automation" ? "automation" : "chat";
  return (
    <Modal centered onClose={onClose} opened={opened} title={`New ${noun}`}>
      <Stack>
        <Text size="sm">Choose the machine that will own this {noun}.</Text>
        <Select
          aria-label="Executor"
          data={choices.map((choice) => ({ label: choice.name, value: choice.id }))}
          onChange={setExecutorId}
          value={executorId}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button disabled={!executorId} onClick={() => { if (executorId) onConfirm(executorId); }}>
            Continue
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
