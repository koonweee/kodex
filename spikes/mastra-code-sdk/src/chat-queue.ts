import type { AgentMessageInput } from '@mastra/core/agent';
import { validChatInput, type ChatInput } from './chat-input.js';
import { randomUUID } from 'node:crypto';
import type { NativeSession } from './runtime.js';
import { captureChatFastRequestContext } from './chat-fast.js';

export type ChatQueueInput = ChatInput;
export interface ChatQueueRow {
  id: string;
  input: ChatQueueInput;
  nativeSignalId: string | null;
  status: 'queued' | 'steering' | 'uncertain' | 'recoverable';
}
export interface ChatQueueSnapshot {
  epoch: string; revision: number; nativeCount: number;
  /** Detectable native count gap; false does not prove complete native membership. */
  partial: boolean; rows: ChatQueueRow[];
}
export interface ChatQueueResult { outcome: 'applied' | 'conflict' | 'uncertain'; snapshot: ChatQueueSnapshot }
interface Selection { id: string; revision: number }
type Agent = ReturnType<NativeSession['machinery']['getAgent']>;
type Submission = ReturnType<Agent['queueMessage']>;
interface Prepared {
  message: AgentMessageInput;
  agent: Agent;
  options: Awaited<ReturnType<NativeSession['machinery']['buildStreamOptions']>>;
  context: Awaited<ReturnType<typeof captureChatFastRequestContext>>;
}
interface RecordRow { row: ChatQueueRow; prepared?: Prepared; receiptEligible?: boolean; acknowledgmentPending?: boolean; admissionWitness?: boolean }
interface Planned { record: RecordRow; input: ChatQueueInput; prepared: Prepared }

/** Volatile input editing around native dispatch, not a queue runner. Only the
 * native signal ID admits a row; queue counts and text never establish delivery.
 * Unchanged/reordered inputs retain submission-time options. Editing text is a
 * new submission and captures current settings. Prepared contexts stay private.
 */
export function createChatQueue(session: NativeSession, options: { epoch: string; onChanged?: () => void; prepareInput?: (input: ChatQueueInput) => Promise<AgentMessageInput> }) {
  const threadId = session.thread.getId();
  if (!threadId) throw new Error('Queue requires a loaded native chat.');
  const resourceId = session.identity.getResourceId();
  const owner = `kodex-queue-${randomUUID()}`;
  const records: RecordRow[] = [];
  let revision = 0;
  let disposed = false;
  let gate: Promise<unknown> = Promise.resolve();
  function assertActive() { if (disposed) throw new Error('The chat queue is closed.'); }
  function nativeCount() { return session.displayState.get().queuedFollowUps; }
  function partial(count = nativeCount()) { return count > records.filter(record => record.row.status === 'queued' && record.row.nativeSignalId !== null).length; }
  function snapshot(): ChatQueueSnapshot {
    const count = nativeCount();
    return { epoch: options.epoch, revision, nativeCount: count, partial: partial(count), rows: records.map(({ row }) => ({ ...row, input: structuredClone(row.input) })) };
  }
  function changed() {
    if (disposed) return;
    revision++;
    // A projection subscriber cannot turn successful native submission into a
    // retryable write failure or interrupt the synchronous cancellation batch.
    try { options.onChanged?.(); } catch { /* Projection refills remain authoritative. */ }
  }
  function result(outcome: ChatQueueResult['outcome'] = 'applied'): ChatQueueResult { return { outcome, snapshot: snapshot() }; }
  function serial<T>(run: () => T | Promise<T>): Promise<T> {
    const next = gate.then(() => { assertActive(); return run(); });
    gate = next.catch(() => undefined);
    return next;
  }
  function input(value: ChatQueueInput): ChatQueueInput {
    if (!validChatInput(value)) throw new Error('Queue input must contain text or attachments.');
    return { text: value.text,
      ...(value.images && { images: value.images.map(image => ({ id: image.id, fileName: image.fileName, mimeType: image.mimeType, sizeBytes: image.sizeBytes, path: image.path })) }),
      ...(value.files && { files: value.files.map(file => ({ id: file.id, fileName: file.fileName, extension: file.extension, relativePath: file.relativePath, absolutePath: typeof file.absolutePath === 'string' ? file.absolutePath : '', mimeType: file.mimeType, sizeBytes: file.sizeBytes })) }),
    };
  }
  function find(id: string) { return records.find(record => record.row.id === id); }
  function removeRecord(record: RecordRow) {
    const index = records.indexOf(record);
    if (index < 0) return;
    record.prepared = undefined;
    records.splice(index, 1);
  }
  function uncertain(record: RecordRow, nativeSignalId = record.row.nativeSignalId) {
    if (!records.includes(record)) return;
    record.row.nativeSignalId = nativeSignalId;
    if (nativeSignalId === null) record.receiptEligible = false;
    record.row.status = 'uncertain';
    record.prepared = undefined;
  }
  const unsubscribe = session.subscribe(event => {
    if (disposed) return;
    if (event.type === 'follow_up_queued') { changed(); return; }
    if (event.type !== 'message_start') return;
    const admitted = records.find(record => record.row.nativeSignalId === event.message.id);
    if (admitted?.receiptEligible) {
      if (admitted.acknowledgmentPending) admitted.admissionWitness = true;
      else { removeRecord(admitted); changed(); }
    }
  });
  async function prepare(value?: ChatQueueInput): Promise<Prepared> {
    try {
      if (value && (value.images?.length || value.files?.length) && !options.prepareInput) throw new Error('Attachments require native preparation.');
      const message = value ? structuredClone(options.prepareInput ? await options.prepareInput(structuredClone(value)) : value.text) : '';
      const context = await captureChatFastRequestContext(session);
      const agent = session.machinery.getAgent();
      session.ensureFollowUpBinding(agent, resourceId, threadId!);
      const nativeOptions = await session.machinery.buildStreamOptions({ requestContext: context, abortSignal: new AbortController().signal });
      assertActive();
      return { message, agent, context, options: nativeOptions };
    } catch { throw new Error('Native queue preparation failed.'); }
  }
  function submit(plan: Planned): Submission {
    const native = plan.prepared.agent.queueMessage(structuredClone(plan.prepared.message), {
      resourceId, threadId: threadId!, queueOwnerId: owner, ifIdle: { streamOptions: plan.prepared.options },
    });
    plan.record.row.input = structuredClone(plan.input);
    plan.record.row.nativeSignalId = native.signal.id;
    plan.record.row.status = 'queued';
    plan.record.prepared = plan.prepared;
    // This call requests native default delivery/wake, never memory-only persist.
    // Buffer early ID witnesses until the native routing decision is known.
    plan.record.receiptEligible = true;
    plan.record.acknowledgmentPending = true;
    plan.record.admissionWitness = false;
    return native;
  }
  async function acknowledge(record: RecordRow, native: Submission) {
    try {
      const decision = await native.accepted;
      record.acknowledgmentPending = false;
      if (decision.action === 'wake' || decision.action === 'deliver') {
        if (record.admissionWitness && records.includes(record)) { removeRecord(record); changed(); }
        return true;
      }
      record.receiptEligible = false;
      if (records.includes(record)) {
        if (decision.action === 'blocked' || decision.action === 'discard') {
          // These policies neither execute nor store this signal. Keep its input
          // for an explicit draft restoration, never automatic native retry.
          record.row.status = 'recoverable';
          record.row.nativeSignalId = null;
          record.prepared = undefined;
        } else {
          // Memory-only persistence is not queued execution. Its write may not
          // yet be settled, so preserve identity without promising redelivery.
          uncertain(record);
          void native.persisted?.catch(() => undefined);
        }
        changed();
      }
      return false;
    }
    catch {
      record.acknowledgmentPending = false;
      if (!records.includes(record)) return true;
      if (record.admissionWitness && record.receiptEligible) { removeRecord(record); changed(); return true; }
      uncertain(record); changed();
      return false;
    }
  }
  function cancel(selected: RecordRow[]): Set<string> | undefined {
    try {
      const cancelled = new Set<string>();
      // Rows can hold different native mode agents. Cancellation still uses the
      // original submission's agent and signal ID, never a new picker value.
      const agents = new Set(selected.map(record => record.prepared!.agent));
      for (const agent of agents) {
        const signalIds = selected.filter(record => record.prepared!.agent === agent).map(record => record.row.nativeSignalId!);
        for (const id of agent.cancelQueuedMessages({ resourceId, threadId: threadId!, signalIds }).cancelledSignalIds) cancelled.add(id);
      }
      return cancelled;
    } catch {
      // Native setup/cancellation callbacks may throw after state changed. No
      // automatic restoration is safe without a confirmed cancellation result.
      for (const record of selected) uncertain(record);
      changed();
      return undefined;
    }
  }
  const editable = (record: RecordRow | undefined): record is RecordRow => !!record && record.row.status === 'queued' && !!record.prepared && !!record.row.nativeSignalId;

  async function replace(selected: RecordRow[], desired: Planned[], expectedRevision: number) {
    if (revision !== expectedRevision) return result('conflict');
    const originals: Planned[] = selected.map(record => ({ record, input: structuredClone(record.row.input), prepared: record.prepared! }));
    const confirmed = cancel(selected);
    if (!confirmed) return result('uncertain');
    const conflict = originals.some(plan => !confirmed.has(plan.record.row.nativeSignalId!));
    const plan = conflict ? originals.filter(item => confirmed.has(item.record.row.nativeSignalId!)) : desired;
    for (const item of originals) {
      if (!confirmed.has(item.record.row.nativeSignalId!)) uncertain(item.record);
      else { item.record.prepared = undefined; item.record.row.nativeSignalId = null; item.record.receiptEligible = false; }
    }
    if (!conflict) {
      // Keep the untouched prefix; desired is the complete reordered suffix.
      const start = Math.min(...selected.map(record => records.indexOf(record)).filter(index => index >= 0));
      const selectedSet = new Set(selected);
      const retained = records.filter(record => !selectedSet.has(record));
      retained.splice(start, 0, ...desired.map(item => item.record));
      records.splice(0, records.length, ...retained);
    }
    const acknowledgments: Array<Promise<boolean>> = [];
    let failed = false;
    for (let index = 0; index < plan.length; index++) {
      const item = plan[index]!;
      try { acknowledgments.push(acknowledge(item.record, submit(item))); }
      catch {
        // The call may have enqueued before throwing and returning its ID.
        item.record.row.input = structuredClone(item.input);
        uncertain(item.record, null);
        for (const tail of plan.slice(index + 1)) {
          tail.record.row.input = structuredClone(tail.input);
          tail.record.row.nativeSignalId = null;
          tail.record.row.status = 'recoverable';
          tail.record.prepared = undefined;
          tail.record.receiptEligible = false;
        }
        failed = true;
        break;
      }
    }
    changed();
    const accepted = await Promise.all(acknowledgments);
    return result(failed || accepted.some(ok => !ok) ? 'uncertain' : conflict ? 'conflict' : 'applied');
  }

  return {
    snapshot,
    enqueue(value: ChatQueueInput): Promise<ChatQueueResult & { rowId: string }> {
      const nextInput = input(value);
      return serial(async () => {
        const prepared = await prepare(nextInput);
        const record: RecordRow = { row: { id: randomUUID(), input: nextInput, nativeSignalId: null, status: 'queued' }, prepared };
        records.push(record);
        let accepted = false;
        try { const native = submit({ record, input: nextInput, prepared }); changed(); accepted = await acknowledge(record, native); }
        catch { uncertain(record, null); changed(); }
        return { ...result(accepted ? 'applied' : 'uncertain'), rowId: record.row.id };
      });
    },
    edit(selection: Selection & { input: Pick<ChatQueueInput, 'text'> }) {
      const nextText = selection.input?.text;
      if (typeof nextText !== 'string') throw new Error('Queue input must contain text or attachments.');
      return serial(async () => {
        const chosen = find(selection.id);
        if (selection.revision !== revision || partial() || !editable(chosen)) return result('conflict');
        const suffix = records.slice(records.indexOf(chosen));
        if (!suffix.every(editable)) return result('conflict');
        const nextInput = input({ ...structuredClone(chosen.row.input), text: nextText });
        if (chosen.row.input.text === nextInput.text) return result();
        const prepared = await prepare(nextInput);
        if (selection.revision !== revision || partial()) return result('conflict');
        return replace(suffix, suffix.map(record => ({ record, input: record === chosen ? nextInput : structuredClone(record.row.input), prepared: record === chosen ? prepared : record.prepared! })), selection.revision);
      });
    },
    reorder(selection: { ids: string[]; revision: number }) {
      const ids = [...selection.ids];
      return serial(async () => {
        if (selection.revision !== revision || partial() || !records.every(editable) || ids.length !== records.length || new Set(ids).size !== ids.length || ids.some(id => !find(id))) return result('conflict');
        if (ids.every((id, index) => records[index]!.row.id === id)) return result();
        await prepare();
        if (selection.revision !== revision || partial()) return result('conflict');
        return replace([...records], ids.map(id => { const record = find(id)!; return { record, input: structuredClone(record.row.input), prepared: record.prepared! }; }), selection.revision);
      });
    },
    remove(selection: Selection) {
      return serial(() => {
        const record = find(selection.id);
        if (selection.revision !== revision || !editable(record)) return result('conflict');
        const confirmed = cancel([record]);
        if (!confirmed) return result('uncertain');
        if (!confirmed.has(record.row.nativeSignalId!)) { uncertain(record); changed(); return result('conflict'); }
        removeRecord(record); changed(); return result();
      });
    },
    steer(selection: Selection) {
      return serial(() => {
        const record = find(selection.id);
        if (selection.revision !== revision || !editable(record)) return result('conflict');
        const context = record.prepared!.context, message = structuredClone(record.prepared!.message);
        const confirmed = cancel([record]);
        if (!confirmed) return result('uncertain');
        if (!confirmed.has(record.row.nativeSignalId!)) { uncertain(record); changed(); return result('conflict'); }
        record.row.nativeSignalId = null;
        record.row.status = 'steering';
        record.receiptEligible = false;
        record.prepared = undefined;
        try {
          const messageInput = typeof message === 'string' || Array.isArray(message) ? { contents: message } : message;
          // Match native hard steering: abort preserves other queued signals,
          // and Session.sendSignal owns the abort-aware multipart startup.
          session.abort();
          const native = session.sendSignal({ type: 'user', ...messageInput }, { requestContext: context, requireDelivery: true });
          const settled = native.accepted.then(decision => {
            if (decision.action !== 'wake' && decision.action !== 'deliver') throw new Error('Native steering was not admitted.');
          });
          // Publish transfer immediately; admission does not promise completion
          // and must not hold the response or command gate until the model ends.
          void settled.then(() => {
            if (!disposed && records.includes(record)) { removeRecord(record); changed(); }
          }, () => {
            if (!disposed && records.includes(record)) { uncertain(record, null); changed(); }
          });
          changed(); return result();
        } catch { uncertain(record, null); changed(); return result('uncertain'); }
      });
    },
    reconcile(selection: Selection) {
      return serial(async () => {
        const record = find(selection.id);
        if (selection.revision !== revision || !record) return result('conflict');
        const signalId = record.row.nativeSignalId;
        if (!signalId || !record.receiptEligible || !['queued', 'uncertain'].includes(record.row.status)) return result('uncertain');
        try {
          const context = await session.machinery.buildRequestContext();
          const memory = await session.machinery.getAgent().getMemory({ requestContext: context });
          const store = await memory?.storage?.getStore('memory');
          const receipts = (await store?.listMessagesById({ messageIds: [signalId] }))?.messages;
          assertActive();
          if (selection.revision !== revision || find(selection.id) !== record || record.row.nativeSignalId !== signalId || !record.receiptEligible) return result('conflict');
          // Positive admission/storage receipt for this default-wake submission,
          // never completion or proof of non-delivery. Missing rows stay unknown.
          const receipt = receipts?.length === 1 ? receipts[0] : undefined;
          const signal = receipt?.content.metadata?.signal;
          if (receipt?.id === signalId && receipt.threadId === threadId && receipt.resourceId === resourceId && receipt.role === 'signal'
            && typeof signal === 'object' && signal !== null && 'id' in signal && signal.id === signalId
            && 'type' in signal && (signal.type === 'user' || signal.type === 'user-message')) {
            removeRecord(record); changed(); return result();
          }
        } catch { /* Native read failure never authorizes retry or redelivery. */ }
        return result('uncertain');
      });
    },
    dismiss(selection: Selection) {
      return serial(() => {
        const record = find(selection.id);
        if (selection.revision !== revision || !record || !['uncertain', 'recoverable'].includes(record.row.status)) return result('conflict');
        removeRecord(record); changed(); return result();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true; unsubscribe();
      for (const record of records) record.prepared = undefined;
      records.splice(0);
      // Native accepted work remains native-owned; disposal never cancels it.
    },
  };
}
