import { useEffect, useRef, useState } from 'react';
import type { QueueController } from '../queuedInputs/controller';
import { errorMessageFrom } from '../shared/values';
import { mastraClient, type ChatSnapshot } from './client';

type Snapshot = ChatSnapshot['queue'];
function queueInputView(input: Snapshot['rows'][number]['input']): unknown[] {
  return [{ type: 'text', text: input.text },
    ...(input.images ?? []).map(image => ({ type: 'localImage', path: image.path })),
    ...(input.files ?? []).map(file => ({ type: 'file', path: file.relativePath }))];
}
export function useMastraQueue(chatId: string | null, snapshot: Snapshot | null, onError: (error: unknown) => void, onReload?: () => void): QueueController {
  const scope = JSON.stringify([chatId, snapshot?.epoch]);
  const active = useRef(scope); active.current = scope;
  const generation = useRef(0);
  const running = useRef<{ scope: string; token: number } | null>(null);
  const [operation, setOperation] = useState<{ scope: string; busy: boolean; error: string | null } | null>(null);
  useEffect(() => { generation.current++; return () => { generation.current++; }; }, [scope]);
  const selection = (id: string) => ({ chatId: chatId!, epoch: snapshot!.epoch, revision: snapshot!.revision, id });
  async function mutate(action: () => Promise<{ outcome: 'applied' | 'conflict' | 'uncertain' }>) {
    if (!chatId || !snapshot || running.current?.scope === scope) return false;
    const token = generation.current;
    running.current = { scope, token };
    setOperation({ scope, busy: true, error: null });
    try {
      const result = await action();
      if (active.current !== scope || generation.current !== token) return false;
      // Reply snapshots never replace the canonical watchChat projection.
      const error = result.outcome === 'conflict' ? 'The queue changed. Review the current queue before trying again.'
        : result.outcome === 'uncertain' ? 'Delivery could not be confirmed. Check the conversation and saved input before sending again.' : null;
      setOperation({ scope, busy: false, error });
      return result.outcome === 'applied';
    } catch (failure) {
      if (active.current === scope && generation.current === token) {
        setOperation({ scope, busy: false, error: errorMessageFrom(failure) });
        onError(failure);
      }
      return false;
    } finally { if (running.current?.scope === scope && running.current.token === token) running.current = null; }
  }
  const rows = snapshot?.rows ?? [];
  const controller: QueueController = {
    rows: rows.filter(row => row.status === 'queued' || row.status === 'steering').map(row => ({ id: row.id,
      input: queueInputView(row.input), attachmentCount: (row.input.images?.length ?? 0) + (row.input.files?.length ?? 0), canSteer: row.status === 'queued', disabled: row.status === 'steering', editDisabled: snapshot?.partial })),
    recovery: rows.filter(row => row.status === 'uncertain' || row.status === 'recoverable').map(row => ({ id: row.id,
      input: queueInputView(row.input), savedInput: row.input, status: row.status as 'uncertain' | 'recoverable' })),
    busy: operation?.scope === scope && operation.busy,
    error: operation?.scope === scope ? operation.error : null,
    partial: snapshot?.partial ?? false, hasPendingInput: (snapshot?.nativeCount ?? 0) > 0, reorderDisabled: rows.some(row => row.status !== 'queued'),
    version: JSON.stringify([snapshot?.epoch, snapshot?.revision]),
    reload: () => { if (onReload) { setOperation(null); onReload(); } else setOperation({ scope, busy: false, error: 'Queue reload is not available.' }); },
    steerFirst: () => {
      const first = rows.find(row => row.status === 'queued');
      if (!first) return false;
      void mutate(() => mastraClient.steerQueued(selection(first.id))); return true;
    },
    edit: (row, input) => mutate(() => mastraClient.editQueued({ ...selection(row.id), input: { text: input.flatMap(value => typeof value === 'object' && value !== null && 'type' in value && value.type === 'text' && 'text' in value && typeof value.text === 'string' ? [value.text] : []).join('\n') } })),
    reorder: ids => mutate(() => mastraClient.reorderQueued({ chatId: chatId!, epoch: snapshot!.epoch, revision: snapshot!.revision, ids })),
    remove: row => mutate(() => mastraClient.removeQueued(selection(row.id))),
    steer: row => mutate(() => mastraClient.steerQueued(selection(row.id))),
    dismiss: row => mutate(() => mastraClient.dismissQueued(selection(row.id))),
    reconcile: row => mutate(() => mastraClient.reconcileQueued(selection(row.id))),
  };
  return controller;
}
