import { deleteQueuedInput, dismissQueueTransfer, reconcileQueueTransfer, reorderQueuedInputs, steerQueuedInput, updateQueuedInput } from "../api/client";
import { errorMessageFrom } from "../shared/values";
import type { NativeQueueController } from "./useNativeQueue";
import type { QueueController } from "./controller";
import { QueuePanel } from "./QueuePanel";

export function legacyQueueController(threadId: string, queue: NativeQueueController): QueueController {
  const { query, busy, error, reload, mutate } = queue;
  return {
    rows: (query.data?.queuedInputs ?? []).map(row => ({ id: row.id, input: row.input, attachmentCount: row.attachments.length, canSteer: row.canSteer })),
    recovery: (query.data?.transfers ?? []).filter(row => row.phase === "uncertain").map(row => ({ id: row.id, input: row.input, status: "uncertain", error: row.error })),
    busy, error: error ?? (query.error ? errorMessageFrom(query.error) : null), partial: Boolean(query.data?.nextCursor), reload, steerFirst: queue.steerFirst,
    edit: (row, input) => mutate(() => updateQueuedInput(threadId, row.id, input)),
    reorder: ids => mutate(() => reorderQueuedInputs(threadId, ids)),
    steer: row => mutate(() => steerQueuedInput(threadId, row.id)),
    remove: row => mutate(() => deleteQueuedInput(threadId, row.id)),
    reconcile: row => mutate(() => reconcileQueueTransfer(row.id)),
    dismiss: row => mutate(() => dismissQueueTransfer(row.id)),
  };
}
export function NativeQueuePanel({ threadId, queue, controller, ...props }: {
  threadId: string; queue: NativeQueueController; controller?: QueueController;
  isActive?: boolean; onRestoreText: (text: string) => void; canRestoreText: boolean;
}) {
  return <QueuePanel controller={controller ?? legacyQueueController(threadId, queue)} {...props} />;
}
