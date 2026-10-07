import { Box, Button, Group, Modal, TextInput } from '@mantine/core';
import type { FormEvent } from 'react';

/** Shared main rename form. Saved names remain owned by the caller's backend. */
export function RenameThreadDialog({ opened, title, name, pending, error, onChange, onClose, onSubmit }: {
  opened: boolean; title: string; name: string; pending: boolean; error: string | null;
  onChange: (value: string) => void; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <Modal centered onClose={onClose} opened={opened} title="Rename thread">
    <Box component="form" onSubmit={onSubmit}>
      <TextInput autoFocus data-autofocus description="Type a name and press Enter." disabled={pending} error={error}
        label="Thread name" onChange={event => onChange(event.currentTarget.value)} placeholder={title} value={name} />
      <Group justify="flex-end" mt="md">
        <Button color="gray" disabled={pending} onClick={onClose} type="button" variant="light">Cancel</Button>
        <Button loading={pending} type="submit">Rename</Button>
      </Group>
    </Box>
  </Modal>;
}
