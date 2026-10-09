import { Alert, Box, Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { useEffect, useState } from "react";

import {
  deleteQueuedInput, dismissQueueTransfer, reconcileQueueTransfer,
  reorderQueuedInputs, updateQueuedInput,
  type QueuedInput, type QueueTransfer,
} from "../api/client";
import { appendResponseAnnotations, type DraftAnnotation } from "../composer/annotations";
import { ComposerAnnotations } from "../composer/ComposerAnnotations";
import { errorMessageFrom } from "../shared/values";
import { parseResponseAnnotations } from "../timeline/responseAnnotations";
import type { NativeQueueController } from "./useNativeQueue";
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

export function NativeQueuePanel({ threadId, queue, onRestoreText, canRestoreText, isActive = true }: {
  threadId: string;
  queue: NativeQueueController;
  isActive?: boolean;
  onRestoreText: (text: string) => void;
  canRestoreText: boolean;
}) {
  const { query, busy, error, reload, mutate } = queue;
  const [editing, setEditing] = useState<QueuedInput | null>(null);
  const [edits, setEdits] = useState(new Map<number, QueuedTextEdit>());
  const [restoring, setRestoring] = useState<QueueTransfer | null>(null);
  const [inspecting, setInspecting] = useState<QueueTransfer | null>(null);
  useEffect(() => {
    if (!isActive) {
      setEditing(null);
      setRestoring(null);
      setInspecting(null);
    }
  }, [isActive]);
  const rows = query.data?.queuedInputs ?? [];
  const transfers = (query.data?.transfers ?? []).filter((transfer) => transfer.phase === "uncertain");

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
    void mutate(() => updateQueuedInput(threadId, editing.id, replaceQueueText(editing.input, textEdits)), () => setEditing(null));
  }

  return <>
    {error || query.error ? <Alert color="red" title="Queue unavailable" mb="xs">
      {error ?? errorMessageFrom(query.error)}
      <Button size="compact-sm" variant="subtle" onClick={reload}>Reload queue</Button>
    </Alert> : null}
    {rows.length > 0 ? <QueuedMessageList rows={rows} busy={busy} partial={Boolean(query.data?.nextCursor)}
      onReorder={(ids) => void mutate(() => reorderQueuedInputs(threadId, ids))}
      onSendNow={(row) => queue.sendNow(row.id)}
      transferringIds={(query.data?.transfers ?? []).map((transfer) => transfer.nativeQueueId)}
      onEdit={(row) => {
        setEditing(row);
        setEdits(new Map(editableQueueText(row.input).map(({ index, text }) => [index, queuedTextEdit(text)])));
      }}
      onRemove={(row) => void mutate(() => deleteQueuedInput(threadId, row.id))} /> : null}
    {transfers.length > 0 ? <Box role="region" aria-label="Queue transfers" className="kodex-native-queue">
      {transfers.map((transfer) => <Box key={transfer.id} role="group" aria-label="Queue transfer" className="kodex-native-queue-row">
        <Text size="sm" fw={600}>Delivery uncertain</Text>
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>{queueInputPreview(transfer.input)}</Text>
        {transfer.error ? <Text size="xs" c="red">{transfer.error}</Text> : null}
        <Group gap="xs" wrap="wrap">
          <Button size="compact-sm" disabled={busy} onClick={() => void mutate(() => reconcileQueueTransfer(transfer.id))}>Reconcile</Button>
          <Button size="compact-sm" variant="subtle" onClick={() => setInspecting(transfer)}>Saved input</Button>
          <Button size="compact-sm" variant="subtle" disabled={busy || !canRestoreText || restorableQueueText(transfer.input) === null} onClick={() => setRestoring(transfer)}>Restore to composer</Button>
          <Button size="compact-sm" variant="subtle" color="red" disabled={busy} onClick={() => void mutate(() => dismissQueueTransfer(transfer.id))}>Dismiss</Button>
        </Group>
        {restorableQueueText(transfer.input) === null ? <Text size="xs">This native input cannot be restored losslessly in the text composer. Open Saved input to copy the complete JSON.</Text> : null}
        {!canRestoreText ? <Text size="xs">Clear the current draft and attachments before restoring saved text.</Text> : null}
      </Box>)}
    </Box> : null}
    <Modal opened={isActive && editing !== null} title="Edit queued message" onClose={() => !busy && setEditing(null)}>
      {editing ? <Stack gap="sm">
        {editableQueueText(editing.input).map(({ index }, position) => {
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
        {editableQueueText(editing.input).length === 0 ? <Text>No editable text in this native input.</Text> : <Button disabled={busy} onClick={saveEditing}>Save queued message</Button>}
      </Stack> : null}
    </Modal>
    <Modal opened={isActive && restoring !== null} title="Restore saved input" onClose={() => setRestoring(null)}>
      <Stack><Alert color="yellow">This input may already have been delivered. Restoring only creates an unsent draft; sending it again can duplicate the message.</Alert>
        <Button disabled={!canRestoreText} onClick={() => {
          const text = restoring ? restorableQueueText(restoring.input) : null;
          if (text !== null && canRestoreText && isActive) { onRestoreText(text); setRestoring(null); }
        }}>Restore text</Button>
      </Stack>
    </Modal>
    <Modal opened={isActive && inspecting !== null} title="Saved native input" onClose={() => setInspecting(null)}>
      <Textarea aria-label="Saved native input JSON" readOnly autosize minRows={6} maxRows={18} value={JSON.stringify(inspecting?.input ?? [], null, 2)} />
    </Modal>
  </>;
}
