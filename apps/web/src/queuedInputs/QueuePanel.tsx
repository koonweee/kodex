import { Alert, Box, Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { useEffect, useState } from "react";

import { appendResponseAnnotations, type DraftAnnotation } from "../composer/annotations";
import { ComposerAnnotations } from "../composer/ComposerAnnotations";
import { parseResponseAnnotations } from "../timeline/responseAnnotations";
import type { QueueController, QueueRowView, QueueRecoveryView } from "./controller";
import { QueuedMessageList } from "./QueuedMessageList";
import { editableQueueText, queueInputPreview, replaceQueueText, restorableQueueText } from "./input";

type QueuedTextEdit = { text: string; annotations: DraftAnnotation[]; original: string; dirty: boolean };

function queuedTextEdit(original: string): QueuedTextEdit {
  const parsed = parseResponseAnnotations(original);
  return {
    text: parsed?.text ?? original,
    annotations: parsed?.annotations.map((annotation, index) => ({ ...annotation, id: String(index) })) ?? [],
    original,
    dirty: false,
  };
}

export function QueuePanel({ controller, onRestoreText, canRestoreText, isActive = true }: {
  controller: QueueController;
  isActive?: boolean;
  onRestoreText: (text: string) => void;
  canRestoreText: boolean;
}) {
  const { rows, recovery: transfers, busy, error, reload } = controller;
  const [editing, setEditing] = useState<{ row: QueueRowView; save: QueueController["edit"] } | null>(null);
  const [edits, setEdits] = useState(new Map<number, QueuedTextEdit>());
  const [restoring, setRestoring] = useState<QueueRecoveryView | null>(null);
  const [inspecting, setInspecting] = useState<QueueRecoveryView | null>(null);
  useEffect(() => {
    if (!isActive) {
      setEditing(null);
      setRestoring(null);
      setInspecting(null);
    }
  }, [isActive]);

  function updateEdit(index: number, change: (edit: QueuedTextEdit) => QueuedTextEdit) {
    setEdits((current) => {
      const edit = current.get(index);
      if (!edit) return current;
      return new Map(current).set(index, { ...change(edit), dirty: true });
    });
  }

  function saveEditing() {
    if (!editing) return;
    const textEdits = new Map([...edits].map(([index, edit]) => [index,
      edit.dirty ? appendResponseAnnotations(edit.text, edit.annotations) : edit.original,
    ]));
    void editing.save(editing.row, replaceQueueText(editing.row.input, textEdits)).then(applied => { if (applied) setEditing(current => current === editing ? null : current); });
  }

  const errorNotice = error ? <Alert color="red" title="Queue unavailable" mb="xs">
    {error}
    <Button size="compact-sm" variant="subtle" onClick={reload}>Reload queue</Button>
  </Alert> : null;
  return <>
    {editing === null ? errorNotice : null}
    {rows.length > 0 || controller.partial ? <QueuedMessageList rows={rows} busy={busy} partial={controller.partial} isActive={isActive} reorderDisabled={controller.reorderDisabled} version={controller.version}
      onReorder={(ids) => void controller.reorder(ids)}
      onSteer={(row) => void controller.steer(row)}
      onEdit={(row) => {
        setEditing({ row, save: controller.edit });
        setEdits(new Map(editableQueueText(row.input).map(({ index, text }) => [index, queuedTextEdit(text)])));
      }}
      onRemove={(row) => void controller.remove(row)} /> : null}
    {transfers.length > 0 ? <Box role="region" aria-label="Queue transfers" className="kodex-native-queue">
      {transfers.map((transfer) => <Box key={transfer.id} role="group" aria-label="Queue transfer" className="kodex-native-queue-row">
        <Text size="sm" fw={600}>{transfer.status === "recoverable" ? "Input not delivered" : "Delivery uncertain"}</Text>
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>{queueInputPreview(transfer.input)}</Text>
        {transfer.error ? <Text size="xs" c="red">{transfer.error}</Text> : null}
        <Group gap="xs" wrap="wrap">
          <Button size="compact-sm" disabled={busy} onClick={() => void controller.reconcile(transfer)}>Reconcile</Button>
          <Button size="compact-sm" variant="subtle" onClick={() => setInspecting(transfer)}>Saved input</Button>
          <Button size="compact-sm" variant="subtle" disabled={busy || !canRestoreText || restorableQueueText(transfer.input) === null} onClick={() => setRestoring(transfer)}>Restore to composer</Button>
          <Button size="compact-sm" variant="subtle" color="red" disabled={busy} onClick={() => void controller.dismiss(transfer)}>Dismiss</Button>
        </Group>
        {restorableQueueText(transfer.input) === null ? <Text size="xs">This native input cannot be restored losslessly in the text composer. Open Saved input to copy the complete JSON.</Text> : null}
        {!canRestoreText ? <Text size="xs">Clear the current draft and attachments before restoring saved text.</Text> : null}
      </Box>)}
    </Box> : null}
    <Modal closeButtonProps={{ 'aria-label': 'Close' }} opened={isActive && editing !== null} title="Edit queued message" onClose={() => !busy && setEditing(null)}>
      {editing ? <Stack gap="sm">
        {errorNotice}
        {editableQueueText(editing.row.input).map(({ index }, position) => {
          const edit = edits.get(index);
          if (!edit) return null;
          return <Box key={index}>
            <Textarea label={position === 0 ? "Queued message text" : `Queued message text ${position + 1}`}
              autosize minRows={3} value={edit.text} disabled={busy}
              onChange={(event) => {
                const text = event.currentTarget.value;
                updateEdit(index, (current) => ({ ...current, text }));
              }} />
            <ComposerAnnotations disabled={busy} draftState={{
              annotations: edit.annotations,
              annotationFocusId: null,
              clearAnnotationFocus: () => undefined,
              updateAnnotation: (id, comment) => updateEdit(index, (current) => ({ ...current,
                annotations: current.annotations.map((annotation) => annotation.id === id ? { ...annotation, comment } : annotation),
              })),
              removeAnnotation: (id) => updateEdit(index, (current) => ({ ...current,
                annotations: current.annotations.filter((annotation) => annotation.id !== id),
              })),
            }} />
          </Box>;
        })}
        {editableQueueText(editing.row.input).length === 0 ? <Text>No editable text in this native input.</Text> : <Button disabled={busy} onClick={saveEditing}>Save queued message</Button>}
      </Stack> : null}
    </Modal>
    <Modal closeButtonProps={{ 'aria-label': 'Close' }} opened={isActive && restoring !== null} title="Restore saved input" onClose={() => setRestoring(null)}>
      <Stack><Alert color="yellow">{restoring?.status === "recoverable" ? "This input was not admitted for delivery. Restoring creates an unsent draft." : "This input may already have been delivered. Restoring only creates an unsent draft; sending it again can duplicate the message."}</Alert>
        <Button disabled={!canRestoreText} onClick={() => {
          const text = restoring ? restorableQueueText(restoring.input) : null;
          if (text !== null && canRestoreText && isActive) { onRestoreText(text); setRestoring(null); }
        }}>Restore text</Button>
      </Stack>
    </Modal>
    <Modal closeButtonProps={{ 'aria-label': 'Close' }} opened={isActive && inspecting !== null} title="Saved native input" onClose={() => setInspecting(null)}>
      <Textarea aria-label="Saved native input JSON" readOnly autosize minRows={6} maxRows={18} value={JSON.stringify(inspecting?.savedInput ?? inspecting?.input ?? [], null, 2)} />
    </Modal>
  </>;
}
