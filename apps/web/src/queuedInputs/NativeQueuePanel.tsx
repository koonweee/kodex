import { Alert, Box, Button, Group, Modal, Stack, Text, Textarea } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  deleteQueuedInput, dismissQueueTransfer, listQueuedInputs, reconcileQueueTransfer,
  reorderQueuedInputs, steerQueuedInput, updateQueuedInput,
  type QueuedInput, type QueueTransfer,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { errorMessageFrom } from "../shared/values";
import { refreshQueuedInputs } from "./cache";
import { editableQueueText, queueInputPreview, replaceQueueText, restorableQueueText } from "./input";

export function NativeQueuePanel({ threadId, onRestoreText, canRestoreText, isActive = true }: {
  threadId: string;
  isActive?: boolean;
  onRestoreText: (text: string) => void;
  canRestoreText: boolean;
}) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.queuedInputs(threadId), queryFn: ({ signal }) => listQueuedInputs(threadId, signal) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<QueuedInput | null>(null);
  const [edits, setEdits] = useState(new Map<number, string>());
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
  const transfers = query.data?.transfers ?? [];

  async function mutate(action: () => Promise<unknown>, onSuccess?: () => void) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); onSuccess?.(); }
    catch (failure) { setError(errorMessageFrom(failure)); }
    finally {
      // A failed/lost mutation reply is not proof that native state stayed put.
      await refreshQueuedInputs(client, threadId);
      setBusy(false);
    }
  }

  function move(index: number, offset: number) {
    const ids = rows.map((row) => row.id);
    [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
    void mutate(() => reorderQueuedInputs(threadId, ids));
  }

  return <>
    {error || query.error ? <Alert color="red" title="Queue unavailable" mb="xs">
      {error ?? errorMessageFrom(query.error)}
      <Button size="compact-sm" variant="subtle" onClick={() => { setError(null); void refreshQueuedInputs(client, threadId); }}>Reload queue</Button>
    </Alert> : null}
    {rows.length > 0 ? <Box role="region" aria-label="Queued messages" className="kodex-native-queue">
      <Text size="xs" c="dimmed">Queued work uses the chat settings at execution time.</Text>
      {query.data?.nextCursor ? <Text size="xs">The native queue returned a partial page. Reordering is unavailable until the complete queue can be shown.</Text> : null}
      {rows.map((row, index) => <Box key={row.id} role="group" aria-label="Queued message" className="kodex-native-queue-row">
        <Text size="sm" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{queueInputPreview(row.input)}</Text>
        {row.attachments.length > 0 ? <Text size="xs">{row.attachments.length} attached file(s)</Text> : null}
        <Group gap="xs" wrap="wrap">
          {row.canSteer ? <Button size="compact-sm" disabled={busy} onClick={() => void mutate(() => steerQueuedInput(threadId, row.id))}>Steer</Button> : null}
          <Button size="compact-sm" variant="subtle" disabled={busy} onClick={() => { setEditing(row); setEdits(new Map()); }}>Edit</Button>
          <Button size="compact-sm" variant="subtle" disabled={busy || index === 0 || Boolean(query.data?.nextCursor)} onClick={() => move(index, -1)}>Move up</Button>
          <Button size="compact-sm" variant="subtle" disabled={busy || index === rows.length - 1 || Boolean(query.data?.nextCursor)} onClick={() => move(index, 1)}>Move down</Button>
          <Button size="compact-sm" variant="subtle" color="red" disabled={busy} onClick={() => void mutate(() => deleteQueuedInput(threadId, row.id))}>Remove</Button>
        </Group>
      </Box>)}
    </Box> : null}
    {transfers.length > 0 ? <Box role="region" aria-label="Queue transfers" className="kodex-native-queue">
      {transfers.map((transfer) => <Box key={transfer.id} role="group" aria-label="Queue transfer" className="kodex-native-queue-row">
        <Text size="sm" fw={600}>{transfer.phase === "uncertain" ? "Delivery uncertain" : transfer.phase === "accepted" ? "Awaiting native receipt" : "Transferring queued message"}</Text>
        <Text size="sm" style={{ overflowWrap: "anywhere" }}>{queueInputPreview(transfer.input)}</Text>
        {transfer.error ? <Text size="xs" c="red">{transfer.error}</Text> : null}
        <Group gap="xs" wrap="wrap">
          <Button size="compact-sm" disabled={busy} onClick={() => void mutate(() => reconcileQueueTransfer(transfer.id))}>Reconcile</Button>
          <Button size="compact-sm" variant="subtle" onClick={() => setInspecting(transfer)}>Saved input</Button>
          {transfer.phase === "uncertain" ? <>
            <Button size="compact-sm" variant="subtle" disabled={busy || !canRestoreText || restorableQueueText(transfer.input) === null} onClick={() => setRestoring(transfer)}>Restore to composer</Button>
            <Button size="compact-sm" variant="subtle" color="red" disabled={busy} onClick={() => void mutate(() => dismissQueueTransfer(transfer.id))}>Dismiss</Button>
          </> : null}
        </Group>
        {transfer.phase === "uncertain" && restorableQueueText(transfer.input) === null ? <Text size="xs">This native input cannot be restored losslessly in the text composer. Open Saved input to copy the complete JSON.</Text> : null}
        {transfer.phase === "uncertain" && !canRestoreText ? <Text size="xs">Clear the current draft and attachments before restoring saved text.</Text> : null}
      </Box>)}
    </Box> : null}
    <Modal opened={isActive && editing !== null} title="Edit queued message" onClose={() => !busy && setEditing(null)}>
      {editing ? <Stack gap="sm">
        {editableQueueText(editing.input).map(({ index, text }, position) => <Textarea key={index} label={position === 0 ? "Queued message text" : `Queued message text ${position + 1}`} autosize minRows={3} value={edits.get(index) ?? text} onChange={(event) => setEdits(new Map(edits).set(index, event.currentTarget.value))} disabled={busy} />)}
        <Text size="xs">Other native input stays attached. Editing text clears its old text annotations.</Text>
        {editableQueueText(editing.input).length === 0 ? <Text>No editable text in this native input.</Text> : <Button disabled={busy} onClick={() => void mutate(() => updateQueuedInput(threadId, editing.id, replaceQueueText(editing.input, edits)), () => setEditing(null))}>Save queued message</Button>}
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
